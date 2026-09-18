/**
 * The TypeSafe backend.
 *
 * The SDK already retries and already honors `Retry-After`, so this configures
 * that rather than reimplementing it, and adds the one thing the SDK does not
 * have: a budget for the whole call including retries. A screen sits in front of
 * a tool call the agent is waiting on, so an unbounded sequence of per-attempt
 * timeouts is not something the caller can be asked to live with.
 *
 * Nothing here reads the API key. The SDK takes it from `TYPESAFE_API_KEY`
 * itself, which keeps the value out of this package entirely, and SDK logging is
 * pinned off because at `debug` it writes request bodies, and the bodies here
 * are the screened tool traffic.
 *
 * Request shapes the SDK would refuse are a strict subset of what validateBattery
 * refuses first, so nothing gets as far as the SDK's own validation.
 *
 * No text a server sent is copied into a failure message or into a stored field.
 * The status and the error class are read; the response body is not. Those
 * messages reach the audit log, and the agent can be shown the audit log, so a
 * server that answered with a sentence would be writing into the agent's input.
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';
import type {
  EntryType,
  Fetch,
  Question as SdkQuestion,
  Questions as SdkQuestions,
  ScoreCriteria,
} from '@typesafe-ai/sdk';

import { failure, safeLabel } from './message.js';
import type {
  AskOptions,
  Backend,
  Battery,
  BackendResult,
  FailedResult,
  Question,
} from './types.js';
import { validateAnswers, validateBattery } from './validate.js';

export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';

/** Per attempt, matching the SDK default. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** The whole call, retries and backoff included. */
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

export interface TypeSafeBackendOptions {
  /** Model override. Without one the SDK resolves its own default. */
  readonly model?: string;
  /** API root override, for a gateway or a recorded fixture server. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxRetries?: number;
  /** Transport override. Tests drive the adapter through this instead of the network. */
  readonly fetch?: Fetch;
}

/**
 * Whether a key is configured, so a caller can say once at startup that screens
 * are off rather than discovering it on the first tool call. Reads the variable
 * to see whether it is set, and does nothing else with it.
 */
export function hasTypeSafeKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[TYPESAFE_API_KEY_ENV];
  return typeof value === 'string' && value.trim() !== '';
}

function toSdkQuestion(question: Question): SdkQuestion {
  switch (question.kind) {
    case 'noul':
      return question.criteria === undefined
        ? { type: 'noul', instructions: question.instructions }
        : { type: 'noul', instructions: question.instructions, criteria: question.criteria };
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: question.criteria };
    case 'score':
      // The SDK types a rubric as a tuple of at least two entries, which is what
      // validateBattery has already refused to send without.
      return {
        type: 'score',
        instructions: question.instructions,
        criteria: question.criteria as unknown as ScoreCriteria,
      };
  }
}

function toSdkQuestions(battery: Battery): SdkQuestions {
  // `fromEntries` rather than assignment, so an id spelled `__proto__` becomes
  // an own property instead of reaching the prototype setter and vanishing.
  return Object.fromEntries(
    Object.entries(battery).map(([id, question]) => [id, toSdkQuestion(question)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** An error class name, which comes from the runtime rather than from a response body. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

function nameOf(error: unknown): string {
  const name = isRecord(error) && typeof error['name'] === 'string' ? error['name'] : '';
  return ERROR_NAME.test(name) ? name : 'Error';
}

function fromStatus(status: number): FailedResult {
  if (status === 401 || status === 403) {
    return failure('unauthorized', false, `the API rejected the credentials (${status})`);
  }
  if (status === 408) {
    return failure('timeout', true, 'the API timed out the request (408)');
  }
  if (status === 429) {
    return failure('rate-limited', true, 'the API rate limit was exhausted (429)');
  }
  if (status >= 500) {
    return failure('unavailable', true, `the API failed to answer (${status})`);
  }
  if (status >= 400) {
    return failure('invalid-request', false, `the API refused the request (${status})`);
  }
  return failure('unknown', false, `the API answered with an unexpected status (${status})`);
}

/**
 * What went wrong, said in our own words.
 *
 * Only the status and the error class are read. Even the message of an error
 * raised inside this process is left out, because those messages quote the data
 * that caused them, and the data here is the tool traffic being screened.
 */
function classify(error: unknown, cancelledByCaller: boolean): FailedResult {
  const name = nameOf(error);

  if (name === 'APIUserAbortError') {
    return cancelledByCaller
      ? failure('aborted', false, 'the caller cancelled the request')
      : failure('timeout', true, 'the request ran past its budget');
  }
  if (isRecord(error) && typeof error['status'] === 'number') {
    return fromStatus(error['status']);
  }
  if (name === 'APITimeoutError') {
    return failure('timeout', true, 'the request timed out');
  }
  if (name === 'APIConnectionError') {
    return failure('unavailable', true, 'the API could not be reached');
  }
  return failure('unknown', false, `the request failed (${name})`);
}

type BudgetCause = 'budget' | 'caller';

interface Budget {
  readonly signal: AbortSignal;
  /** Which source aborted, latched when it fired rather than read back afterwards. */
  cause(): BudgetCause | undefined;
  dispose(): void;
}

/**
 * One signal that fires on either the caller's cancellation or our own deadline,
 * and remembers which came first. The SDK reports both as the same abort, and
 * the difference decides whether this reads as a timeout or as the caller
 * changing its mind, which is not the same thing to whoever reads the log.
 */
function budgetFor(totalMs: number, caller: AbortSignal | undefined): Budget {
  const controller = new AbortController();
  let cause: BudgetCause | undefined;

  const abort = (source: BudgetCause) => () => {
    cause ??= source;
    controller.abort();
  };
  const relay = abort('caller');
  const timer = setTimeout(abort('budget'), totalMs);
  timer.unref();
  caller?.addEventListener('abort', relay, { once: true });

  return {
    signal: controller.signal,
    cause: () => cause,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', relay);
    },
  };
}

type Setup = { readonly ok: true; readonly client: TypeSafeClient } | FailedResult;

function setUp(
  options: TypeSafeBackendOptions,
  timeoutMs: number,
  totalTimeoutMs: number,
  maxRetries: number,
): Setup {
  for (const [label, value] of [
    ['timeoutMs', timeoutMs],
    ['totalTimeoutMs', totalTimeoutMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      return failure('invalid-request', false, `${label} must be a positive number`);
    }
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    return failure('invalid-request', false, 'maxRetries must be a whole number, zero or more');
  }

  try {
    return {
      ok: true,
      client: new TypeSafeClient({
        ...(options.model === undefined ? {} : { defaultModel: options.model }),
        ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        logLevel: 'off',
        timeout: timeoutMs,
        retry: {
          maxRetries,
          respectRetryAfter: true,
          // No point waiting past the budget the whole call has to live in.
          maxRetryAfterMs: totalTimeoutMs,
        },
      }),
    };
  } catch (error) {
    // This one keeps its message. It comes from the SDK reading the local
    // configuration, not from anything a server or a screened tool call said,
    // and it is the line that tells an operator which variable is wrong.
    const message = isRecord(error) && typeof error['message'] === 'string' ? error['message'] : '';
    return failure(
      'unauthorized',
      false,
      message === '' ? 'the backend is not configured' : message,
    );
  }
}

/**
 * A backend over the TypeSafe API.
 *
 * Never throws, including when the key is missing or the options are wrong. The
 * proxy has to start whether or not screening is configured, so a configuration
 * problem is captured here and reported on every call instead.
 */
export function createTypeSafeBackend(options: TypeSafeBackendOptions = {}): Backend {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const setup = setUp(options, timeoutMs, totalTimeoutMs, maxRetries);

  return {
    name: 'typesafe',
    async ask<const B extends Battery>(
      state: unknown,
      battery: B,
      askOptions?: AskOptions,
    ): Promise<BackendResult<B>> {
      if (!setup.ok) {
        return setup;
      }
      const problem = validateBattery(battery);
      if (problem !== undefined) {
        return failure('invalid-request', false, problem);
      }
      if (askOptions?.signal?.aborted === true) {
        return failure('aborted', false, 'the caller cancelled the request');
      }

      const budget = budgetFor(totalTimeoutMs, askOptions?.signal);
      const started = performance.now();
      try {
        const result: unknown = await setup.client.systemOne(
          {
            state: (state === undefined ? null : state) as EntryType,
            questions: toSdkQuestions(battery),
          },
          { signal: budget.signal },
        );
        const latencyMs = performance.now() - started;
        if (!isRecord(result)) {
          return failure('malformed-response', false, 'the API answered with no result');
        }
        const validation = validateAnswers(battery, result['answers']);
        if (!validation.ok) {
          return failure('malformed-response', false, validation.problem);
        }
        const usage = result['usage'];
        const inputTokens = isRecord(usage) ? usage['input_tokens'] : undefined;
        return {
          ok: true,
          answers: validation.answers,
          model: safeLabel(result['model']),
          // A token count that did not arrive, or arrived as something a count
          // cannot be, is worth nothing and is not worth failing a screen over.
          // The answers are what gates the tool call.
          inputTokens:
            typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0
              ? inputTokens
              : 0,
          latencyMs,
        };
      } catch (error) {
        return classify(error, budget.cause() === 'caller');
      } finally {
        budget.dispose();
      }
    },
  };
}
