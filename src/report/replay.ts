/**
 * Deciding again, with a different policy, over what was already judged.
 *
 * Choosing a threshold by reasoning about it is guesswork. The log holds the
 * probabilities every past decision was taken from, and the decision functions
 * are pure, so a different policy can be run over real traffic and the answer is
 * what would have happened rather than what might.
 *
 * What this reproduces is the decision, not the session. The floors that a
 * screen raises when it could not read all of something are applied where the
 * record says they were in play, but nothing re-sends a request, so an answer
 * the model never gave cannot appear here. A threshold moved below a probability
 * nobody measured changes nothing, and that is a real limit rather than a
 * reassurance: the log can only tell you about calls you actually made.
 */

import type { AuditRecord, JudgmentRecord } from '../audit/index.js';
import {
  decidePostResult,
  decidePreCall,
  type CallAnswers,
  type CallRuleFindings,
  type Policy,
  type ResultAnswers,
  type ResultRuleFindings,
} from '../policy/index.js';

export interface Change {
  readonly id: string;
  readonly server: string;
  readonly tool: string;
  readonly kind: 'call' | 'result';
  /** What the policy in force at the time wanted. */
  readonly was: string;
  /** What the policy being tried wants. */
  readonly now: string;
  /** True when the new policy acts where the old one did not. */
  readonly stricter: boolean;
}

export interface Replay {
  /** Judgments that carried enough to decide again. */
  readonly replayed: number;
  /** Judgments skipped because no model answered them, so there is nothing to re-decide. */
  readonly skipped: number;
  readonly changes: readonly Change[];
  readonly stricter: number;
  readonly looser: number;
}

/** Ranked by how much each action withholds, which is what stricter means. */
const WEIGHT: Record<string, number> = {
  forward: 0,
  pass: 0,
  annotate: 1,
  redact: 2,
  hold: 3,
  quarantine: 3,
  block: 4,
};

function isJudgment(record: AuditRecord): record is JudgmentRecord {
  return record.kind === 'call' || record.kind === 'result';
}

export function replay(records: readonly AuditRecord[], policy: Policy): Replay {
  const changes: Change[] = [];
  let replayed = 0;
  let skipped = 0;

  for (const record of records) {
    if (!isJudgment(record)) {
      continue;
    }
    // A decision taken with no model behind it has no probabilities to re-read,
    // so a different threshold cannot change it. Counted rather than ignored,
    // because a log that is mostly these says the policy was never really tested.
    if (!record.screened) {
      skipped += 1;
      continue;
    }

    const was = (record.intended as { kind?: string } | undefined)?.kind;
    if (was === undefined) {
      skipped += 1;
      continue;
    }

    const decided =
      record.kind === 'call'
        ? decidePreCall(
            (record.answers ?? {}) as CallAnswers,
            (record.rules ?? {}) as CallRuleFindings,
            policy,
          )
        : decidePostResult(
            (record.answers ?? {}) as ResultAnswers,
            (record.rules ?? {}) as ResultRuleFindings,
            policy,
          );

    replayed += 1;
    const now = decided.intended.kind;
    if (now !== was) {
      changes.push({
        id: record.id,
        server: record.server,
        tool: record.tool,
        kind: record.kind,
        was,
        now,
        stricter: (WEIGHT[now] ?? 0) > (WEIGHT[was] ?? 0),
      });
    }
  }

  return {
    replayed,
    skipped,
    changes,
    stricter: changes.filter((one) => one.stricter).length,
    looser: changes.filter((one) => !one.stricter).length,
  };
}

export function formatReplay(result: Replay, path: string): string {
  if (result.replayed === 0) {
    const why =
      result.skipped > 0
        ? ` ${result.skipped} ${result.skipped === 1 ? 'judgment had' : 'judgments had'} no model answer behind ${result.skipped === 1 ? 'it' : 'them'}, so no threshold could change ${result.skipped === 1 ? 'it' : 'them'}.`
        : '';
    return `Nothing to replay.${why}`;
  }

  const lines: string[] = [];
  lines.push(
    `Replayed ${result.replayed} ${result.replayed === 1 ? 'judgment' : 'judgments'} against ${path}.`,
  );
  if (result.skipped > 0) {
    lines.push(
      `${result.skipped} skipped: no model answered them, so no threshold changes what they did.`,
    );
  }

  if (result.changes.length === 0) {
    lines.push('');
    lines.push('Every decision comes out the same. This policy would not have changed anything.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(
    result.changes.length === 1
      ? `One would come out differently: ${result.stricter} stricter, ${result.looser} looser.`
      : `${result.changes.length} would come out differently: ${result.stricter} stricter, ${result.looser} looser.`,
  );
  lines.push('');
  for (const change of result.changes) {
    lines.push(`  ${change.id}  ${change.server}/${change.tool}  ${change.was} -> ${change.now}`);
  }
  lines.push('');
  lines.push('`agent-chaperone show <id>` prints what each of those was about.');
  return lines.join('\n');
}
