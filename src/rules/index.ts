/**
 * The deterministic layer.
 *
 * Everything here runs before a question is asked, costs nothing, and is the
 * reason the tool still does something useful with no API key configured. It is
 * pure: text and policy in, findings out.
 */

import type { CallRuleFindings, ResultRuleFindings, ServerPolicy } from '../policy/index.js';
import { splitIntoBlocks, type Block } from './blocks.js';
import { firstMatch } from './globs.js';
import { findHiddenInText, findHiddenRegions, type HiddenKind } from './hidden.js';
import { redactJson, redactText, type SecretKind } from './secrets.js';
import { collectStrings, findDangerousForms, type DangerousMatch } from './shell.js';

export interface ToolCallInspection extends CallRuleFindings {
  /** Arguments with every secret-shaped run replaced, ready to leave the process. */
  readonly redacted_arguments: unknown;
  /** Which kinds were replaced. Positions would index strings no caller holds. */
  readonly secrets: readonly SecretKind[];
  readonly dangerous: readonly DangerousMatch[];
}

export interface ResultInspection extends ResultRuleFindings {
  /** The result split for the post-result question, with secrets already replaced. */
  readonly blocks: readonly Block[];
  /** The whole redacted result, so a caller can forward what the peer should see. */
  readonly redacted_text: string;
  readonly secrets: readonly SecretKind[];
  /** Blocks past the cap, which were not included, and how much text that was. */
  readonly dropped_blocks: number;
  readonly dropped_chars: number;
  /**
   * Every kind of concealment found anywhere in the result, including in text
   * that the block cap excluded or that a block boundary cut in half. The
   * per-block regions locate what they can; this says nothing was missed.
   */
  readonly hidden_kinds: readonly HiddenKind[];
}

export interface CallInspectionInput {
  readonly tool: string;
  readonly arguments: unknown;
  readonly server: ServerPolicy;
  readonly redaction: readonly SecretKind[];
}

/**
 * Everything knowable about a tool call without asking anything.
 *
 * The allow list is checked after the deny list, matching the order the
 * decision function applies, so the reason a call is blocked is the specific
 * one rather than the general one.
 */
export function inspectToolCall(input: CallInspectionInput): ToolCallInspection {
  const denied = firstMatch(input.server.deny_tools, input.tool);
  const outsideAllowList =
    input.server.allow_tools.length > 0 &&
    firstMatch(input.server.allow_tools, input.tool) === undefined;

  const redacted = redactJson(input.arguments, input.redaction);
  // Scanned after redaction, because a match records the text that matched and
  // that text goes into the audit log. Scanning the original would put the
  // credential straight into the record redaction exists to keep it out of.
  const dangerous = collectStrings(redacted.value).flatMap((text) => findDangerousForms(text));

  return {
    ...(denied === undefined ? {} : { denied_by: denied }),
    ...(outsideAllowList ? { outside_allow_list: true } : {}),
    redacted_arguments: redacted.value,
    secrets: redacted.secrets,
    dangerous: dedupe(dangerous),
  };
}

export interface ResultInspectionInput {
  readonly text: string;
  readonly redaction: readonly SecretKind[];
  readonly maxBlockChars?: number;
  readonly maxBlocks?: number;
}

/**
 * The result, prepared for the post-result question.
 *
 * Redaction happens before splitting, so a secret cannot survive by sitting
 * across a block boundary, and the offsets reported for hidden text refer to
 * the blocks the model is actually shown.
 */
export function inspectResult(input: ResultInspectionInput): ResultInspection {
  const redacted = redactText(input.text, input.redaction);
  const split = splitIntoBlocks(redacted.text, {
    ...(input.maxBlockChars === undefined ? {} : { maxBlockChars: input.maxBlockChars }),
    ...(input.maxBlocks === undefined ? {} : { maxBlocks: input.maxBlocks }),
  });
  const hidden = findHiddenRegions(split.blocks);
  // Also scanned whole. A marker split by the character cap, or sitting in a
  // block past the block cap, would otherwise be reported nowhere while the
  // result still reaches the agent.
  const everywhere = new Set(findHiddenInText(redacted.text).map((region) => region.kind));

  return {
    blocks: split.blocks,
    redacted_text: redacted.text,
    secrets: redacted.secrets.map((secret) => secret.kind),
    dropped_blocks: split.dropped,
    dropped_chars: split.dropped_chars,
    hidden_kinds: [...everywhere],
    ...(hidden.length === 0 ? {} : { hidden_regions: hidden }),
  };
}

function dedupe(matches: readonly DangerousMatch[]): readonly DangerousMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => (seen.has(match.name) ? false : (seen.add(match.name), true)));
}

export { splitIntoBlocks, DEFAULT_MAX_BLOCK_CHARS, DEFAULT_MAX_BLOCKS } from './blocks.js';
export type { Block, SplitResult } from './blocks.js';
export { firstMatch, matchesGlob } from './globs.js';
export { findHiddenInText, findHiddenRegions } from './hidden.js';
export type { HiddenKind, HiddenRegion } from './hidden.js';
export {
  SECRET_KINDS,
  SECRET_PATTERNS,
  findSecrets,
  placeholder,
  redactJson,
  redactText,
} from './secrets.js';
export { MAX_JSON_DEPTH, MAX_MATCHES } from './secrets.js';
export type { SecretKind, SecretMatch, SecretPattern } from './secrets.js';
export {
  DANGEROUS_PATTERNS,
  MAX_ARGUMENT_DEPTH,
  MAX_SCAN_CHARS,
  collectStrings,
  findDangerousForms,
} from './shell.js';
export type { DangerousMatch, DangerousPattern } from './shell.js';
