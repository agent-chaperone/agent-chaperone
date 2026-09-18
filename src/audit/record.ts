/**
 * One line per screened message.
 *
 * The record is what makes a threshold tunable: a user reads their own traffic
 * and sees where the probabilities actually fall, rather than taking a default
 * on trust. `replay` in a later version re-applies a policy to these same lines,
 * so the shape carries what a decision was made from and not only what it was.
 *
 * Content is stored as it was sent to the model, which is to say already
 * redacted. The log must not hold a secret the request did not carry: a user
 * grepping their own audit trail for what went wrong should not be the way a
 * credential ends up on disk.
 */

import { sanitizeMessage } from '../backends/index.js';
import type { Judgment } from '../screening/index.js';

/**
 * The published price per million input tokens for the model the benchmark ran
 * against. Output tokens are free. A second backend would bring its own price,
 * and this moves with it rather than being assumed.
 */
export const PRICE_PER_MTOK = 0.042;

export interface AuditContent {
  /** The redacted arguments, for a call. */
  readonly arguments?: unknown;
  /** The redacted result text, for a result. This is what `show` prints. */
  readonly text?: string;
}

export interface AuditRecord {
  readonly ts: string;
  readonly id: string;
  readonly server: string;
  readonly kind: 'call' | 'result';
  readonly tool: string;
  readonly mode: string;
  /** What actually happened, as one word, which is what `log` prints. */
  readonly decision: string;
  /** The whole action, both what the policy chose and what was done about it. */
  readonly intended: unknown;
  readonly applied: unknown;
  /** False when no model was asked, so a forward is not read as an all-clear. */
  readonly screened: boolean;
  readonly answers: unknown;
  readonly rules: unknown;
  readonly secrets: readonly string[];
  readonly model?: string;
  readonly latency_ms?: number;
  readonly input_tokens?: number;
  readonly cost_usd?: number;
  readonly requests?: number;
  readonly failure?: unknown;
  /** Result records only: how the text split, and what the screen never read. */
  readonly blocks?: number;
  readonly unscreened?: unknown;
  readonly hidden?: readonly string[];
  readonly content?: AuditContent;
}

export function costOf(inputTokens: number): number {
  // Rounded to the nearest ten-thousandth of a cent: enough to add up over a
  // session, short enough to read.
  return Math.round((inputTokens / 1_000_000) * PRICE_PER_MTOK * 1e8) / 1e8;
}

export interface RecordOptions {
  readonly now: () => Date;
  /** False keeps the judgments and drops the arguments and the result text. */
  readonly storeContent: boolean;
}

/** One judgment, as the line that goes on disk. */
export function toRecord(judgment: Judgment, options: RecordOptions): AuditRecord {
  const usage = judgment.usage;
  const common = {
    ts: options.now().toISOString(),
    id: judgment.id,
    server: judgment.server,
    tool: judgment.tool,
    mode: judgment.mode,
    decision: judgment.applied.kind,
    intended: judgment.intended,
    applied: judgment.applied,
    screened: judgment.screened,
    answers: judgment.answers,
    rules: judgment.rules,
    secrets: judgment.secrets,
    ...(usage === undefined
      ? {}
      : {
          model: usage.model,
          latency_ms: Math.round(usage.latencyMs),
          input_tokens: usage.inputTokens,
          cost_usd: costOf(usage.inputTokens),
          requests: usage.requests,
        }),
    ...(judgment.failure === undefined ? {} : { failure: judgment.failure }),
  };

  if (judgment.side === 'call') {
    return {
      ...common,
      kind: 'call',
      ...(options.storeContent ? { content: { arguments: judgment.arguments } } : {}),
    };
  }
  return {
    ...common,
    kind: 'result',
    blocks: judgment.blocks,
    unscreened: judgment.unscreened,
    hidden: judgment.hidden,
    ...(options.storeContent ? { content: { text: judgment.text } } : {}),
  };
}

const COLUMN = {
  forward: 'forward',
  pass: 'pass',
  block: 'BLOCK',
  hold: 'HOLD',
  quarantine: 'WITHHELD',
  annotate: 'annotate',
  redact: 'REDACT',
} as const;

/** Written out, because the alternative reads "would have holded". */
const DID = {
  forward: 'forwarded it',
  pass: 'passed it',
  block: 'blocked it',
  hold: 'held it',
  quarantine: 'withheld it',
  annotate: 'annotated it',
  redact: 'redacted it',
} as const;

function probabilities(answers: unknown): string {
  if (typeof answers !== 'object' || answers === null) {
    return '';
  }
  const parts: string[] = [];
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value === 'number') {
      parts.push(`${id} ${value.toFixed(2)}`);
    } else if (typeof value === 'object' && value !== null && 'score' in value) {
      const score = (value as { score: unknown }).score;
      if (typeof score === 'number') {
        parts.push(`${id} ${score.toFixed(1)}`);
      }
    }
  }
  return parts.join(' ');
}

/**
 * One record as a line a person reads.
 *
 * Shadow mode is where this matters most: the decision column says what was
 * done, so a user watching their own traffic sees `forward` beside the
 * probabilities that would have held it, and can decide whether the threshold
 * is in the right place before turning enforcement on.
 */
export function formatRecord(record: AuditRecord): string {
  const time = record.ts.slice(11, 19);
  const applied = record.applied as { kind?: string } | undefined;
  const intended = record.intended as { kind?: string } | undefined;
  // Scrubbed here as well as where the judgment was made. This renders stored
  // data to a terminal, and a line that cannot forge another line should not
  // depend on every writer of the file having been careful.
  const label = COLUMN[record.decision as keyof typeof COLUMN] ?? sanitizeMessage(record.decision);
  const tool = sanitizeMessage(record.tool);
  const wouldHave =
    intended?.kind !== undefined && intended.kind !== applied?.kind
      ? ` (would have ${DID[intended.kind as keyof typeof DID] ?? intended.kind})`
      : '';
  const numbers = probabilities(record.answers);
  const cost = record.cost_usd === undefined ? '' : ` $${record.cost_usd.toFixed(6)}`;
  // A screen that could not run is the case a reader most needs to see: the
  // decision beside it was taken without a model, whatever else the line says.
  const failure = record.failure as { kind?: string } | undefined;
  const unread =
    typeof failure?.kind === 'string'
      ? ` [screen failed: ${sanitizeMessage(failure.kind)}]`
      : record.screened
        ? ''
        : ' [not screened]';
  return `${time} ${record.kind.padEnd(6)} ${label.padEnd(8)} ${tool}${wouldHave}${unread}${numbers === '' ? '' : `  ${numbers}`}${cost}`;
}
