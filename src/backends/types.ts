/**
 * One interface for asking a model a battery of typed questions.
 *
 * The question and answer shapes here are the project's own, not a vendor's.
 * Other backends land later and have to fit this without changing it, and a
 * recorded answer has to stay readable after a vendor's own types move.
 */

/** A yes/no question. The answer is the probability of yes, not a boolean. */
export interface NoulQuestion {
  readonly kind: 'noul';
  readonly instructions: string;
  readonly criteria?: {
    readonly true?: string;
    readonly false?: string;
  };
}

/** A question that picks one of several named outcomes. */
export interface ChoiceQuestion {
  readonly kind: 'choice';
  readonly instructions: string;
  /** Outcome name to its description, or null for an outcome that needs none. */
  readonly criteria: Readonly<Record<string, string | null>>;
}

/** A question that places an answer on an ordered rubric. */
export interface ScoreQuestion {
  readonly kind: 'score';
  readonly instructions: string;
  /** Level descriptions in order from zero. At least two, or the request is invalid. */
  readonly criteria: readonly string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/**
 * Questions keyed by the id the calling code uses. The ids come back on the
 * answers, which is what lets the decision rules name a question rather than
 * count positions.
 */
export type Battery = Readonly<Record<string, Question>>;

export type Answer =
  | { readonly kind: 'noul'; readonly noul: number }
  | {
      readonly kind: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly kind: 'score'; readonly score: number; readonly confidence: number };

/** The answer variant a question of this kind produces. */
export type AnswerFor<Q extends Question> = Extract<Answer, { kind: Q['kind'] }>;

/** Answers under the ids their questions were asked under. */
export type AnswersFor<B extends Battery> = { readonly [K in keyof B]: AnswerFor<B[K]> };

/**
 * Why a request produced no answers.
 *
 * `retryable` describes the failure, not what has already been tried. A backend
 * has usually exhausted its own retries by the time a failure reaches a caller,
 * and the caller uses this to decide how to fail rather than whether to try
 * again: a rate limit is the operator's problem to fix, a bad request is ours.
 */
export interface BackendFailure {
  readonly kind:
    | 'unauthorized'
    | 'rate-limited'
    | 'unavailable'
    | 'timeout'
    | 'aborted'
    | 'invalid-request'
    | 'malformed-response'
    | 'unknown';
  readonly retryable: boolean;
  /**
   * One short line, safe to log. Never a credential, and never text the server
   * chose: failure messages reach the audit log, and the agent can be shown the
   * audit log, so a message is not a place to carry anything untrusted.
   */
  readonly message: string;
}

export interface AnsweredResult<B extends Battery = Battery> {
  readonly ok: true;
  readonly answers: AnswersFor<B>;
  /** The exact model version that answered, so a recorded judgment says what produced it. */
  readonly model: string;
  readonly inputTokens: number;
  readonly latencyMs: number;
}

export interface FailedResult {
  readonly ok: false;
  readonly failure: BackendFailure;
}

/** A failure fits any battery, which is why it carries no type parameter. */
export type BackendResult<B extends Battery = Battery> = AnsweredResult<B> | FailedResult;

export interface AskOptions {
  /**
   * Cancels the request. The proxy holds a tool call while a screen runs, so
   * when the client goes away the screen should stop rather than finish into
   * nothing.
   */
  readonly signal?: AbortSignal;
}

/**
 * A model backend.
 *
 * `ask` does not throw for anything a caller could act on. A screening layer
 * that crashes on a rate limit is worse than one that reports it: the policy
 * already says what shadow and enforce modes do when a screen cannot run, and
 * it can only do that if the failure arrives as a value.
 */
export interface Backend {
  /** Names the backend in the audit log. Not the model. */
  readonly name: string;
  ask<const B extends Battery>(
    state: unknown,
    battery: B,
    options?: AskOptions,
  ): Promise<BackendResult<B>>;
}
