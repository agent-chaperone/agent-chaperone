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
import { MAX_MATCHES } from '../rules/index.js';
import type { Judgment, ToolListJudgment } from '../screening/index.js';

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

export interface JudgmentRecord {
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
  /** Call records only: the approval that released it, when one did. */
  readonly approved?: string;
  /** Result records only: how the text split, and what the screen never read. */
  readonly blocks?: number;
  readonly unscreened?: unknown;
  readonly hidden?: readonly string[];
  readonly content?: AuditContent;
}

/**
 * A pending request dropped to keep the correlator inside its bounds.
 *
 * The bounds are not optional: a peer that never answers would otherwise cost
 * memory without limit. Doing it silently is what was not acceptable. The
 * response the dropped request would have been paired with arrives unpaired,
 * and a screen that wanted the arguments to judge the result gets none, so
 * without this line there is nothing that explains why afterwards.
 */
export interface EvictionRecord {
  readonly ts: string;
  readonly kind: 'eviction';
  readonly server: string;
  /** The JSON-RPC id of the request that was dropped, as text. */
  readonly id: string;
  readonly method: string;
  readonly reason: 'count' | 'bytes';
}

/**
 * What the tool-list screen decided.
 *
 * Its own shape rather than a judgment, because a judgment is built around a
 * call or a result: there is no tool call here, no arguments, and no action,
 * since the list is always relayed. What there is instead is a comparison
 * against what this server advertised first, and sometimes a reading of the
 * descriptions.
 */
export interface ToolListRecord {
  readonly ts: string;
  readonly id: string;
  readonly kind: 'tool-list';
  readonly server: string;
  readonly mode: string;
  /** What happened, as one word, which is what `log` prints. */
  readonly decision: 'learned' | 'unchanged' | 'changed' | 'steering' | 'unchecked';
  /** How many tools the assembled listing carried. */
  readonly tools: number;
  readonly changes?: readonly { readonly kind: string; readonly name: string }[];
  readonly steering?: readonly { readonly name: string; readonly probability: number }[];
  /**
   * Descriptions nothing read: past the cap, too long to judge, or a screen that
   * failed. Not the same as read and found clean, which is why they are named.
   */
  readonly unscreened?: readonly string[];
  /** False when no description was read, so a quiet record is not an all-clear. */
  readonly screened: boolean;
  readonly asked?: number;
  readonly threshold?: number;
  /** When the list being compared against was first recorded. */
  readonly recorded_at?: string;
  readonly model?: string;
  readonly input_tokens?: number;
  readonly cost_usd?: number;
  readonly requests?: number;
  /** The descriptions that were reported, so `show` can print what was judged. */
  readonly content?: { readonly descriptions?: Readonly<Record<string, string>> };
}

export type AuditRecord = JudgmentRecord | EvictionRecord | ToolListRecord;

export function toEvictionRecord(
  input: {
    readonly server: string;
    readonly id: unknown;
    readonly method: string;
    readonly reason: 'count' | 'bytes';
  },
  options: RecordOptions,
): EvictionRecord {
  return {
    ts: options.now().toISOString(),
    kind: 'eviction',
    server: input.server,
    // Both come off the wire and reach a terminal through this file.
    id: sanitizeMessage(String(input.id)),
    method: sanitizeMessage(input.method),
    reason: input.reason,
  };
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

/**
 * What a record holds in place of content it must not keep.
 *
 * The deterministic patterns run before the model is asked, so whatever they
 * matched is already replaced in the text a record would store. A judgment that
 * a credential is present is the backstop for a shape they did not match, which
 * means that credential is still in that text in full. Storing it anyway put a
 * credential on disk by the same judgment that concluded one was there, and the
 * agent was protected while the log was not. Nothing in the battery says where
 * it is, so there is nothing to remove but the whole thing.
 */
const CREDENTIAL_FOUND =
  '[content not stored: a credential was found that the patterns could not locate]';

/**
 * At the cap the scan stopped looking, so secret shapes past that point are
 * still in the content. Nothing here can say which ones survived, and the call
 * side had no guard for this at all: only the result text was checked, while
 * arguments with the same problem were written out whole.
 */
const TOO_MANY = '[content not stored: too many secret shapes to redact them all]';

type ContentJudgment = Exclude<Judgment, { side: 'tool-list' }>;

function tooManyToRedact(judgment: ContentJudgment): boolean {
  return judgment.secrets.length >= MAX_MATCHES;
}

function keep(judgment: ContentJudgment, content: unknown): unknown {
  if (tooManyToRedact(judgment)) {
    return TOO_MANY;
  }
  return foundCredential(judgment) ? CREDENTIAL_FOUND : content;
}

function foundCredential(judgment: ContentJudgment): boolean {
  // The flag is read from the answers at the point they were read. The action is
  // checked too, so a caller that forgets the flag still cannot store a
  // credential the action itself names.
  if (judgment.credential) {
    return true;
  }
  return judgment.side === 'result'
    ? judgment.intended.kind === 'redact'
    : judgment.intended.kind === 'hold' && judgment.intended.reason === 'secret-in-arguments';
}

/**
 * What `log` prints for a listing, as one word.
 *
 * A description that reads as steering outranks a changed list, because it is
 * the stronger statement about the same server. Nothing read at all outranks
 * both: a quiet line about a listing nobody checked would be the misleading one.
 */
function toolListDecision(judgment: ToolListJudgment): ToolListRecord['decision'] {
  if (judgment.steering.length > 0) {
    return 'steering';
  }
  if (judgment.unscreened.length > 0) {
    return 'unchecked';
  }
  if (judgment.learned) {
    return 'learned';
  }
  return judgment.changes.length > 0 ? 'changed' : 'unchanged';
}

/** One tool-list judgment, as the line that goes on disk. */
export function toToolListRecord(
  judgment: ToolListJudgment,
  options: RecordOptions,
): ToolListRecord {
  const usage = judgment.usage;
  const reported = Object.fromEntries(
    judgment.steering.map((one) => [
      sanitizeMessage(one.name),
      sanitizeMessage(judgment.descriptions[one.name] ?? ''),
    ]),
  );
  return {
    ts: options.now().toISOString(),
    id: judgment.id,
    kind: 'tool-list',
    // Every one of these came off the wire and reaches a terminal through here.
    server: sanitizeMessage(judgment.server),
    mode: judgment.mode,
    decision: toolListDecision(judgment),
    tools: judgment.tools,
    screened: judgment.screened,
    asked: judgment.asked,
    threshold: judgment.threshold,
    ...(judgment.changes.length === 0
      ? {}
      : {
          changes: judgment.changes.map((one) => ({
            kind: one.kind,
            name: sanitizeMessage(one.name),
          })),
        }),
    ...(judgment.steering.length === 0
      ? {}
      : {
          steering: judgment.steering.map((one) => ({
            name: sanitizeMessage(one.name),
            probability: one.probability,
          })),
        }),
    ...(judgment.unscreened.length === 0
      ? {}
      : { unscreened: judgment.unscreened.map((one) => sanitizeMessage(one)) }),
    ...(judgment.recordedAt === undefined ? {} : { recorded_at: judgment.recordedAt }),
    ...(usage === undefined
      ? {}
      : {
          model: sanitizeMessage(usage.model),
          input_tokens: usage.inputTokens,
          cost_usd: costOf(usage.inputTokens),
          requests: usage.requests,
        }),
    // A description is a server's text, so it follows the same rule as a result.
    ...(options.storeContent && Object.keys(reported).length > 0
      ? { content: { descriptions: reported } }
      : {}),
  };
}

/** One judgment, as the line that goes on disk. */
export function toRecord(judgment: ContentJudgment, options: RecordOptions): JudgmentRecord {
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
      ...(judgment.approved === undefined ? {} : { approved: judgment.approved }),
      ...(options.storeContent
        ? { content: { arguments: keep(judgment, judgment.arguments) } }
        : {}),
    };
  }
  return {
    ...common,
    kind: 'result',
    blocks: judgment.blocks,
    unscreened: judgment.unscreened,
    hidden: judgment.hidden,
    ...(options.storeContent ? { content: { text: String(keep(judgment, judgment.text)) } } : {}),
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
  if (record.kind === 'eviction') {
    const bound = record.reason === 'count' ? 'too many pending' : 'too many bytes pending';
    return `${time} evict  DROPPED  ${record.method} id=${record.id} (${bound}, so the reply to it cannot be paired)`;
  }
  if (record.kind === 'tool-list') {
    const counted = `${record.tools} ${record.tools === 1 ? 'tool' : 'tools'}`;
    const detail =
      record.decision === 'steering'
        ? ` ${(record.steering ?? []).map((one) => `${one.name} ${one.probability.toFixed(2)}`).join(', ')}`
        : record.decision === 'changed'
          ? ` ${(record.changes ?? []).map((one) => `${one.kind} ${one.name}`).join(', ')}`
          : record.decision === 'unchecked'
            ? ` ${(record.unscreened ?? []).length} unread`
            : '';
    const cost = record.cost_usd === undefined ? '' : ` $${record.cost_usd.toFixed(6)}`;
    // A listing nobody read is the case a reader most needs to see, for the same
    // reason a call nobody screened is: quiet does not mean clear.
    const unread = record.screened ? '' : ' [no description read]';
    const label = record.decision.toUpperCase().padEnd(9);
    return `${time} ${record.id}  ${label} tools/list ${counted}${detail}${unread}${cost}`;
  }
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
  const released = record.approved === undefined ? '' : ' [approved]';
  const unread =
    typeof failure?.kind === 'string'
      ? ` [screen failed: ${sanitizeMessage(failure.kind)}]`
      : record.screened
        ? ''
        : ' [not screened]';
  return `${time} ${record.kind.padEnd(6)} ${label.padEnd(8)} ${tool}${wouldHave}${released}${unread}${numbers === '' ? '' : `  ${numbers}`}${cost}`;
}
