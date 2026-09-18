/**
 * A backend that replays recorded answers.
 *
 * Every test in this package runs against this, so no test reaches the network
 * and no test depends on what a model happens to say today. A request it has no
 * recording for throws instead of answering: a screen that quietly took the
 * failure path would look like a passing test of the failure path, and the gap
 * would never be noticed.
 */

import { requestHash } from './hash.js';
import { failure, safeLabel } from './message.js';
import type {
  Answer,
  AnsweredResult,
  AskOptions,
  Backend,
  Battery,
  BackendResult,
} from './types.js';
import { validateAnswers, validateBattery } from './validate.js';

/** An answer keyed by the hash of the request that produced it. */
export interface Recording {
  readonly hash: string;
  readonly result: BackendResult;
}

/** An answer keyed by the request itself, for fixtures written by hand. */
export interface Exchange {
  readonly state: unknown;
  readonly battery: Battery;
  readonly result: BackendResult;
}

export type FakeEntry = Recording | Exchange;

export interface AskRecord {
  readonly hash: string;
  readonly state: unknown;
  readonly battery: Battery;
}

export interface FakeBackend extends Backend {
  /** Every request made, in order, so a test can assert what was asked. */
  readonly calls: readonly AskRecord[];
}

export class UnknownRequestError extends Error {
  readonly hash: string;

  constructor(hash: string, recorded: number) {
    super(
      `no recorded answer for request ${hash} (${recorded} recorded). Record one, or check whether the question wording changed.`,
    );
    this.name = 'UnknownRequestError';
    this.hash = hash;
  }
}

export class RecordingMismatchError extends Error {
  constructor(hash: string, problem: string) {
    super(`the recording for request ${hash} does not answer the battery: ${problem}`);
    this.name = 'RecordingMismatchError';
  }
}

/**
 * A successful result around a set of answers, for fixtures written by hand.
 * The metadata defaults to something obviously recorded rather than to numbers
 * a reader might mistake for a measurement.
 */
export function answered(
  answers: Readonly<Record<string, Answer>>,
  meta: {
    readonly model?: string;
    readonly inputTokens?: number;
    readonly latencyMs?: number;
  } = {},
): AnsweredResult {
  return {
    ok: true,
    answers,
    model: meta.model ?? 'recorded',
    inputTokens: meta.inputTokens ?? 0,
    latencyMs: meta.latencyMs ?? 0,
  };
}

export function recordingFor(state: unknown, battery: Battery, result: BackendResult): Recording {
  return { hash: requestHash(state, battery), result };
}

function toRecording(entry: FakeEntry): Recording {
  return 'hash' in entry ? entry : recordingFor(entry.state, entry.battery, entry.result);
}

/**
 * A backend over a fixed set of recordings.
 *
 * Two recordings of the same request are refused rather than resolved, because
 * whichever one won would be an arbitrary choice made silently.
 */
export function createFakeBackend(entries: readonly FakeEntry[] = []): FakeBackend {
  const recordings = new Map<string, BackendResult>();
  for (const entry of entries) {
    const recording = toRecording(entry);
    if (recordings.has(recording.hash)) {
      throw new Error(`two recordings for request ${recording.hash}`);
    }
    recordings.set(recording.hash, recording.result);
  }

  const calls: AskRecord[] = [];

  return {
    name: 'fake',
    calls,
    async ask<const B extends Battery>(
      state: unknown,
      battery: B,
      askOptions?: AskOptions,
    ): Promise<BackendResult<B>> {
      const problem = validateBattery(battery);
      if (problem !== undefined) {
        return failure('invalid-request', false, problem);
      }
      if (askOptions?.signal?.aborted === true) {
        return failure('aborted', false, 'the caller cancelled the request');
      }

      const hash = requestHash(state, battery);
      calls.push({ hash, state, battery });

      const result = recordings.get(hash);
      if (result === undefined) {
        throw new UnknownRequestError(hash, recordings.size);
      }
      if (!result.ok) {
        return result;
      }
      // A recording drifting from the battery it is replayed for is the same
      // kind of harness gap as a missing one, so it is just as loud.
      const validation = validateAnswers(battery, result.answers);
      if (!validation.ok) {
        throw new RecordingMismatchError(hash, validation.problem);
      }
      return {
        ok: true,
        answers: validation.answers,
        model: safeLabel(result.model),
        inputTokens: result.inputTokens,
        latencyMs: result.latencyMs,
      };
    },
  };
}
