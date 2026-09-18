/**
 * The post-result screen: a tool result turned into one request per chunk, and
 * the answers merged back into a single verdict.
 *
 * A result can be larger than one request should carry, so the blocks are
 * packed into chunks and each chunk is asked the same questions. Blocks keep the
 * numbering they had in the whole result, which is what makes the block a choice
 * points at meaningful after chunking: it names a block of the result the user
 * would read, not a position inside a chunk they never see.
 *
 * The verdict is the maximum across chunks. A result is dangerous if any part of
 * it is, and an average would let a long benign document bury a single injected
 * paragraph, which is the shape almost every real attack takes.
 */

import type { Answer, Battery } from '../backends/index.js';
import type { ResultAnswers, ScoreAnswer } from '../policy/index.js';
import type { Block } from '../rules/index.js';
import { noulOf, scoreOf } from './precall.js';
import { EXPOSES_SECRET, INSTRUCTS_READER, RESULT_SEVERITY, whichBlock } from './questions.js';

/**
 * How much block text one request carries.
 *
 * Every chunk repeats the questions, so smaller chunks cost more per character
 * of result. This sits well inside the model's context and near the size the
 * measurement was taken at, rather than as large as the context would allow.
 */
export const DEFAULT_MAX_STATE_CHARS = 16_000;

/**
 * How much of the request the tool's own arguments may take.
 *
 * They are context for judging the result, not the thing being judged, and they
 * are repeated in every chunk. Without a cap, an agent that has already been
 * turned can pad the arguments of the call it makes and multiply that padding by
 * the number of chunks the result splits into, pushing every request past what
 * the API will accept so that nothing gets screened at all.
 */
export const MAX_TOOL_CHARS = 2_000;

/** A block id as a choice spells it, bounded so a long run of digits cannot become a block number. */
const BLOCK_ID = /^[0-9]{1,9}$/;

/** Length of the JSON a value would serialize to, or undefined when it would not serialize. */
function jsonLength(value: unknown): number | undefined {
  try {
    return JSON.stringify(value)?.length;
  } catch {
    return undefined;
  }
}

export interface PostResultTool {
  readonly name: string;
  readonly arguments?: unknown;
}

/** What the model is told about concealment, which is that it is there and what kind. */
export interface StateHiddenRegion {
  readonly block: number;
  readonly kind: string;
}

export interface PostResultState {
  readonly tool: PostResultTool;
  readonly blocks: readonly Block[];
  readonly hidden_regions?: readonly StateHiddenRegion[];
}

export interface PostResultInput {
  readonly tool: PostResultTool;
  /** From `inspectResult`. Already redacted and already numbered. */
  readonly blocks: readonly Block[];
  /**
   * From `inspectResult`. Only the block and the kind are read: an offset locates
   * concealment for a reviewer, and is not something the model is being asked
   * about.
   */
  readonly hidden_regions?: readonly StateHiddenRegion[];
  readonly maxStateChars?: number;
}

export interface PostResultScreen {
  readonly state: PostResultState;
  readonly battery: Battery;
}

/**
 * The tool, with arguments it cannot be allowed to make arbitrarily large.
 *
 * Oversized arguments are replaced by a note saying so rather than dropped in
 * silence, because what the model is looking at should be what the state says it
 * is looking at.
 */
function boundedTool(tool: PostResultTool): PostResultTool {
  if (tool.arguments === undefined) {
    return { name: tool.name };
  }
  const length = jsonLength(tool.arguments);
  if (length === undefined) {
    return { name: tool.name, arguments: '[arguments omitted: not representable as JSON]' };
  }
  return length > MAX_TOOL_CHARS
    ? { name: tool.name, arguments: `[arguments omitted: ${length} characters]` }
    : { name: tool.name, arguments: tool.arguments };
}

/**
 * Blocks packed into chunks that each fit the budget.
 *
 * A block larger than the budget on its own gets a chunk to itself rather than
 * being dropped. Screening it oversized is worth more than not screening it,
 * and the block splitter has its own cap on how large one block can be.
 */
export function chunkBlocks(
  blocks: readonly Block[],
  maxStateChars: number = DEFAULT_MAX_STATE_CHARS,
): Block[][] {
  // `Math.max(1, NaN)` is NaN, and every comparison against NaN is false, so a
  // nonsense budget would put the whole result in one chunk instead of the
  // smallest one. Infinity is left alone: that genuinely does mean one chunk.
  const budget = Number.isNaN(maxStateChars) ? 1 : Math.max(1, maxStateChars);
  const chunks: Block[][] = [];
  let current: Block[] = [];
  let used = 0;

  for (const block of blocks) {
    if (current.length > 0 && used + block.text.length > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(block);
    used += block.text.length;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * One request per chunk, or none at all when there is nothing to read.
 *
 * An empty result is not a question worth asking. Returning no screens says so
 * plainly, rather than sending a battery about blocks that are not there.
 */
export function buildPostResultScreens(input: PostResultInput): PostResultScreen[] {
  const tool = boundedTool(input.tool);
  // The budget covers the request, not just its blocks. The tool travels in every
  // chunk, so whatever it takes is taken again each time and has to come out of
  // the same allowance.
  const overhead = jsonLength(tool) ?? 0;
  const budget = Math.max(1, (input.maxStateChars ?? DEFAULT_MAX_STATE_CHARS) - overhead);

  return chunkBlocks(input.blocks, budget).map((blocks) => {
    const ids = new Set(blocks.map((block) => block.id));
    const hidden = (input.hidden_regions ?? [])
      .filter((region) => ids.has(region.block))
      .map((region) => ({ block: region.block, kind: region.kind }));

    const state: PostResultState = {
      tool,
      blocks,
      ...(hidden.length === 0 ? {} : { hidden_regions: hidden }),
    };

    const battery: Battery = {
      instructs_reader: INSTRUCTS_READER,
      severity: RESULT_SEVERITY,
      exposes_secret: EXPOSES_SECRET,
      which_block: whichBlock(blocks.map((block) => block.id)),
    };

    return { state, battery };
  });
}

/**
 * The answers in the shape the decision rules read.
 *
 * A choice of `none` becomes an absent block rather than a block numbered zero,
 * which is a real block and the one a result usually opens with.
 */
export function readResultAnswers(answers: Readonly<Record<string, Answer>>): ResultAnswers {
  const instructs_reader = noulOf(answers, 'instructs_reader');
  const exposes_secret = noulOf(answers, 'exposes_secret');
  const severity = scoreOf(answers, 'severity');

  const choice = answers['which_block'];
  // Digits and nothing else, which is also what refuses `none`. `Number` would
  // turn an empty choice into zero, and zero is a real block, usually the one a
  // result opens with.
  const picked =
    choice?.kind === 'choice' && BLOCK_ID.test(choice.choice) ? Number(choice.choice) : undefined;

  return {
    ...(instructs_reader === undefined ? {} : { instructs_reader }),
    ...(exposes_secret === undefined ? {} : { exposes_secret }),
    ...(severity === undefined ? {} : { severity }),
    ...(picked === undefined ? {} : { which_block: picked }),
  };
}

function larger(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : Math.max(a, b);
}

/**
 * One verdict from the chunks of one result.
 *
 * The block a choice points at comes from the chunk that drove the verdict, not
 * from the last chunk to answer, so the block named in a quarantine notice is
 * the block that caused it. Severity travels with its own confidence, because a
 * score of two answered with no conviction is not the same claim as a score of
 * two answered flatly, and the label the user sees says which it was.
 */
export function mergeResultAnswers(parts: readonly ResultAnswers[]): ResultAnswers {
  const instructs_reader = parts.reduce<number | undefined>(
    (best, part) => larger(best, part.instructs_reader),
    undefined,
  );
  const exposes_secret = parts.reduce<number | undefined>(
    (best, part) => larger(best, part.exposes_secret),
    undefined,
  );
  const severity = parts.reduce<ScoreAnswer | undefined>(
    (best, part) =>
      part.severity !== undefined && (best === undefined || part.severity.score > best.score)
        ? part.severity
        : best,
    undefined,
  );

  // The chunk that drove the verdict, so the block named in a quarantine notice
  // is the block that caused it rather than whichever chunk answered last.
  const leading = parts.reduce<ResultAnswers | undefined>((best, part) => {
    if (best === undefined) {
      return part;
    }
    const here = part.instructs_reader ?? -1;
    const there = best.instructs_reader ?? -1;
    if (here > there) {
      return part;
    }
    return here === there && best.which_block === undefined && part.which_block !== undefined
      ? part
      : best;
  }, undefined);

  return {
    ...(instructs_reader === undefined ? {} : { instructs_reader }),
    ...(exposes_secret === undefined ? {} : { exposes_secret }),
    ...(severity === undefined ? {} : { severity }),
    ...(leading?.which_block === undefined ? {} : { which_block: leading.which_block }),
  };
}
