/**
 * What the policy says to do, given what the model answered.
 *
 * Pure: answers and policy in, an action out. No clock, no I/O, no network.
 * That is what makes a recorded judgment replayable against a different policy
 * without asking the model anything again.
 */

import { policyForServer } from './schema.js';
import type { CallThresholds, Mode, Policy, ResultThresholds } from './schema.js';

/** A Score answer as the model returns it: a position on the levels, plus how concentrated it was. */
export interface ScoreAnswer {
  readonly score: number;
  readonly confidence: number;
}

/**
 * Probabilities from the pre-call battery. Every field is optional: a question
 * may be skipped, as `off_task` is when no task has been recorded, and the
 * backend may be unreachable.
 */
export interface CallAnswers {
  readonly destructive?: number;
  readonly exfiltration?: number;
  readonly secret_in_args?: number;
  readonly policy_violation?: number;
  readonly off_task?: number;
  readonly severity?: ScoreAnswer;
}

/** Probabilities from the post-result battery. */
export interface ResultAnswers {
  readonly instructs_reader?: number;
  readonly exposes_secret?: number;
  readonly severity?: ScoreAnswer;
  /** The block the model pointed at, when it pointed at one. */
  readonly which_block?: number;
}

/** What the deterministic layer found before any question was asked. */
export interface CallRuleFindings {
  /** The deny pattern that matched, when one did. */
  readonly denied_by?: string;
  /** True when an allow list exists and this tool is not on it. */
  readonly outside_allow_list?: boolean;
}

export interface ResultRuleFindings {
  readonly hidden_regions?: readonly { readonly block: number; readonly kind: string }[];
}

export type SeverityLabel = 'none' | 'low' | 'high' | 'critical';

export interface SeverityAssessment {
  readonly label: SeverityLabel;
  readonly score: number;
  /**
   * The model's distribution was spread rather than concentrated. A hold
   * resting on this should read as the tool asking, not asserting.
   */
  readonly uncertain: boolean;
}

export type CallReason =
  | 'deny-list'
  | 'outside-allow-list'
  /** The screen could not run, so nothing about this call was judged. */
  | 'not-screened'
  | 'exfiltration'
  | 'secret-in-arguments'
  | 'destructive'
  | 'policy'
  | 'off-task';

export type CallAction =
  | { readonly kind: 'forward' }
  | { readonly kind: 'block'; readonly reason: CallReason; readonly detail?: string }
  | {
      readonly kind: 'hold';
      readonly reason: CallReason;
      readonly probability: number;
      readonly severity?: SeverityAssessment;
    };

export type ResultAction =
  | { readonly kind: 'pass' }
  /**
   * No block id: nothing in the battery locates a secret. `which_block` answers
   * where an instruction is, and the hidden regions are zero-width characters
   * and comments. Pointing a caller at either would redact the wrong thing and
   * leave the credential in place.
   */
  | { readonly kind: 'redact'; readonly probability: number }
  | { readonly kind: 'annotate'; readonly probability: number; readonly block?: number }
  | {
      readonly kind: 'quarantine';
      readonly probability: number;
      readonly block?: number;
      readonly severity: SeverityAssessment;
    };

/**
 * Both what the policy decided and what actually happens.
 *
 * Shadow mode records the first and applies the second, which is what lets a
 * user read their own log and choose thresholds before anything is blocked.
 */
export interface Decision<Action> {
  readonly intended: Action;
  readonly applied: Action;
}

/** Whether a screen runs at all for this server. */
export function shouldScreen(policy: Policy, server: string, side: 'calls' | 'results'): boolean {
  const settings = policyForServer(policy, server);
  return side === 'calls' ? settings.screen_calls : settings.screen_results;
}

/**
 * Read a Score answer as a labelled severity.
 *
 * The levels are the ones written in the question: 0 none, 1 low, 2 harmful,
 * 3 severe. A continuous score sits between them, so each label claims the
 * nearest level rather than the one below it.
 */
export function assessSeverity(
  answer: ScoreAnswer | undefined,
  uncertainBelowConfidence: number,
): SeverityAssessment | undefined {
  if (answer === undefined) {
    return undefined;
  }
  const label: SeverityLabel =
    answer.score >= 2.5
      ? 'critical'
      : answer.score >= 1.5
        ? 'high'
        : answer.score >= 0.5
          ? 'low'
          : 'none';
  return {
    label,
    score: answer.score,
    uncertain: answer.confidence < uncertainBelowConfidence,
  };
}

/** True when a probability the model may not have returned reaches the threshold. */
function reaches(value: number | undefined, threshold: number): value is number {
  return value !== undefined && value >= threshold;
}

/**
 * The pre-call decision, first match wins.
 *
 * Severity never gates here. It labels the hold so a user can tell a routine
 * overwrite from something irreversible, which is what ADR-0003 settled.
 */
export function decidePreCall(
  answers: CallAnswers,
  rules: CallRuleFindings,
  policy: Policy,
): Decision<CallAction> {
  return decision(
    intendedCallAction(
      answers,
      rules,
      policy.thresholds.call,
      policy.thresholds.uncertain_severity_confidence,
    ),
    policy.mode,
    { kind: 'forward' },
  );
}

function intendedCallAction(
  answers: CallAnswers,
  rules: CallRuleFindings,
  thresholds: CallThresholds,
  uncertainBelowConfidence: number,
): CallAction {
  if (rules.denied_by !== undefined) {
    return { kind: 'block', reason: 'deny-list', detail: rules.denied_by };
  }
  if (rules.outside_allow_list === true) {
    return { kind: 'block', reason: 'outside-allow-list' };
  }

  const severity = assessSeverity(answers.severity, uncertainBelowConfidence);
  const hold = (reason: CallReason, probability: number): CallAction => ({
    kind: 'hold',
    reason,
    probability,
    ...(severity === undefined ? {} : { severity }),
  });

  // Exfiltration and a secret in the arguments are the same concern arriving
  // two ways, so they share a threshold.
  if (reaches(answers.exfiltration, thresholds.hold_exfiltration)) {
    return hold('exfiltration', answers.exfiltration);
  }
  if (reaches(answers.secret_in_args, thresholds.hold_exfiltration)) {
    return hold('secret-in-arguments', answers.secret_in_args);
  }
  if (reaches(answers.destructive, thresholds.hold_destructive)) {
    return hold('destructive', answers.destructive);
  }
  if (reaches(answers.policy_violation, thresholds.hold_policy)) {
    return hold('policy', answers.policy_violation);
  }
  if (reaches(answers.off_task, thresholds.hold_off_task)) {
    return hold('off-task', answers.off_task);
  }
  return { kind: 'forward' };
}

/**
 * The post-result decision, first match wins.
 *
 * Severity chooses between quarantine and annotate rather than deciding whether
 * to act at all. Gating on it would miss the low-harm instructions that make up
 * most of what the benchmark's email set contains.
 */
export function decidePostResult(
  answers: ResultAnswers,
  rules: ResultRuleFindings,
  policy: Policy,
): Decision<ResultAction> {
  return decision(
    intendedResultAction(
      answers,
      rules,
      policy.thresholds.result,
      policy.thresholds.uncertain_severity_confidence,
    ),
    policy.mode,
    { kind: 'pass' },
  );
}

function intendedResultAction(
  answers: ResultAnswers,
  rules: ResultRuleFindings,
  thresholds: ResultThresholds,
  uncertainBelowConfidence: number,
): ResultAction {
  const block = answers.which_block ?? rules.hidden_regions?.[0]?.block;
  const at = (probability: number): { probability: number; block?: number } => ({
    probability,
    ...(block === undefined ? {} : { block }),
  });

  if (reaches(answers.exposes_secret, thresholds.redact_secret)) {
    return { kind: 'redact', probability: answers.exposes_secret };
  }
  if (reaches(answers.instructs_reader, thresholds.quarantine_instructs)) {
    const severity = assessSeverity(answers.severity, uncertainBelowConfidence);
    if (severity !== undefined && severity.score >= thresholds.harmful_severity_level) {
      return { kind: 'quarantine', ...at(answers.instructs_reader), severity };
    }
    return { kind: 'annotate', ...at(answers.instructs_reader) };
  }
  if (reaches(answers.instructs_reader, thresholds.annotate_instructs)) {
    return { kind: 'annotate', ...at(answers.instructs_reader) };
  }
  return { kind: 'pass' };
}

function decision<Action>(intended: Action, mode: Mode, inert: Action): Decision<Action> {
  return { intended, applied: mode === 'shadow' ? inert : intended };
}
