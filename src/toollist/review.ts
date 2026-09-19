/**
 * Comparing an advertised tool list against what the server advertised before.
 *
 * The decision is deliberately small: record, or report what moved. It never
 * withholds a tool list. A client that cannot read the tool list cannot call
 * anything at all, so blocking here would not be a firewall refusing one call,
 * it would be the server appearing to be broken, and a user whose tools vanish
 * uninstalls the thing that made them vanish.
 */

import {
  advertisedTools,
  compareTools,
  printTools,
  readBaseline,
  writeBaseline,
  type ToolChange,
  type ToolPrint,
} from './baseline.js';

export interface ToolListReview {
  /** True the first time this server advertised anything, when there is nothing to compare. */
  readonly learned: boolean;
  readonly tools: readonly ToolPrint[];
  readonly changes: readonly ToolChange[];
  /** When the list this was compared against was recorded. */
  readonly recordedAt?: string;
}

export interface ReviewOptions {
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Record whatever arrived as the new baseline, rather than comparing. This is
   * what accepting a change means, and it is the only way a reported change
   * stops being reported.
   */
  readonly accept?: boolean;
}

export function reviewToolList(
  server: string,
  result: unknown,
  options: ReviewOptions = {},
): ToolListReview {
  const tools = printTools(advertisedTools(result));
  const baseline = options.accept === true ? undefined : readBaseline(server, options.env);

  if (baseline === undefined) {
    // A server that has never been seen is learned rather than reported. There
    // is no version of this that is a finding: every tool would be "new".
    writeBaseline(server, tools, options.now, options.env);
    return { learned: true, tools, changes: [] };
  }

  return {
    learned: false,
    tools,
    changes: compareTools(baseline.tools, tools),
    recordedAt: baseline.recordedAt,
  };
}
