/**
 * Comparing an advertised tool list against what the server advertised first,
 * and asking about the descriptions that have no answer yet.
 *
 * Two jobs, deliberately kept apart. The comparison is evidence: it is measured
 * against the list recorded on first sight, and that record is not rewritten by
 * a later list, or a tampered description would be reported once and then become
 * the expectation. The judgments are a cache: they are keyed by what was judged,
 * so they can be written on any connection without moving the evidence.
 *
 * Neither withholds a tool list. A client that cannot read the tool list cannot
 * call anything, so blocking here would not be a firewall refusing one call, it
 * would be the server appearing to be broken.
 */

import { describableText } from '../screens/toollist.js';
import {
  advertisedTools,
  compareTools,
  judgmentKey,
  learnBaseline,
  printTools,
  readBaseline,
  rememberJudgments,
  type ToolChange,
  type ToolPrint,
} from './baseline.js';

/** A description the screen concluded is doing more than describing its tool. */
export interface SteeringTool {
  readonly name: string;
  readonly probability: number;
}

export interface ToolListReview {
  /** True the first time this server advertised anything, when there is nothing to compare. */
  readonly learned: boolean;
  readonly tools: readonly ToolPrint[];
  readonly changes: readonly ToolChange[];
  /** Descriptions at or above the policy's threshold. */
  readonly steering: readonly SteeringTool[];
  /** Descriptions this run sent, which is what it cost. */
  readonly asked: number;
  /**
   * Descriptions that have no answer, because the cap was reached or a screen
   * failed. Reported, because an unscreened description is not a clean one.
   */
  readonly unscreened: readonly string[];
  /** The list arrived in pages, so it is a slice and removals cannot be read from it. */
  readonly partial: boolean;
  /** When the list being compared against was recorded. */
  readonly recordedAt?: string;
}

/** Asks about one description. Resolves undefined when there is no answer. */
export type AskAboutDescription = (
  name: string,
  description: unknown,
) => Promise<number | undefined>;

/**
 * How many descriptions one connection will send.
 *
 * The count is chosen by the server, so without a cap a list of ten thousand
 * tools is ten thousand requests that the user pays for and waits on. Past this,
 * the rest are reported as unscreened rather than quietly treated as clean.
 */
export const MAX_SCREENED_DESCRIPTIONS = 64;

/** How many of those are in flight at once. */
export const MAX_CONCURRENT_SCREENS = 4;

export interface ReviewOptions {
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  /** At or above this, a description is reported. */
  readonly threshold?: number;
  /** Without one, the comparison still runs and no description is read. */
  readonly ask?: AskAboutDescription;
  readonly maxScreened?: number;
}

/** Run at most `width` at a time, keeping each result with its input. */
async function inBatches<T, R>(
  items: readonly T[],
  width: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length; at += width) {
    const batch = items.slice(at, at + width);
    out.push(...(await Promise.all(batch.map(run))));
  }
  return out;
}

export async function reviewToolList(
  server: string,
  result: unknown,
  options: ReviewOptions = {},
): Promise<ToolListReview> {
  const advertised = advertisedTools(result);
  const tools = printTools(advertised);
  // A paginated listing is a slice of the tool list. What is absent from it is
  // not absent from the server, so removals cannot be read from it.
  const partial =
    result !== null &&
    typeof result === 'object' &&
    (result as { nextCursor?: unknown }).nextCursor !== undefined;

  const baseline = readBaseline(server, options.env);
  const learned = baseline === undefined;
  if (baseline === undefined) {
    learnBaseline(server, tools, options.now, options.env);
  }

  const changes =
    baseline === undefined
      ? []
      : compareTools(baseline.tools, tools).filter(
          (change) => !(partial && change.kind === 'removed'),
        );

  // Keyed by name and digest together, so two entries advertised under the same
  // name are two separate questions and neither inherits the other's answer.
  const keyed = advertised.map((tool, at) => ({
    tool,
    name: String(tool.name),
    print: tools[at],
    key: judgmentKey(String(tool.name), printTools([tool])[0]?.digest ?? ''),
  }));

  const known = baseline?.judgments ?? {};
  const unanswered =
    options.ask === undefined ? [] : keyed.filter((one) => known[one.key] === undefined);
  // A description too long to judge honestly is reported, not screened from its
  // opening: the part that matters could simply sit after the cut.
  const tooLong = unanswered.filter((one) => describableText(one.tool.description) === undefined);
  const pending = unanswered.filter((one) => describableText(one.tool.description) !== undefined);
  const cap = options.maxScreened ?? MAX_SCREENED_DESCRIPTIONS;
  const toAsk = pending.slice(0, cap);
  const overCap = [...pending.slice(cap), ...tooLong].map((one) => one.name);

  const fresh: Record<string, number> = {};
  const failed: string[] = [];
  if (options.ask !== undefined && toAsk.length > 0) {
    const ask = options.ask;
    const answers = await inBatches(toAsk, MAX_CONCURRENT_SCREENS, async (one) => {
      try {
        return await ask(one.name, one.tool.description);
      } catch {
        // A screen that could not run is not a finding, and must not be recorded
        // as one: with no answer stored, the next connection asks again.
        return undefined;
      }
    });
    toAsk.forEach((one, at) => {
      const answer = answers[at];
      if (answer === undefined) {
        failed.push(one.name);
      } else {
        fresh[one.key] = answer;
      }
    });
  }

  const threshold = options.threshold ?? 1;
  const steering: SteeringTool[] = [];
  const seen = new Set<string>();
  for (const one of keyed) {
    seen.add(one.key);
    const answer = fresh[one.key] ?? known[one.key];
    if (answer !== undefined && answer >= threshold) {
      steering.push({ name: one.name, probability: answer });
    }
  }

  if (Object.keys(fresh).length > 0) {
    rememberJudgments(server, fresh, seen, options.env);
  }

  return {
    learned,
    tools,
    changes,
    steering,
    asked: toAsk.length,
    unscreened: [...overCap, ...failed],
    partial,
    ...(baseline === undefined ? {} : { recordedAt: baseline.recordedAt }),
  };
}
