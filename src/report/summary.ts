/**
 * What a session's log adds up to.
 *
 * The README tells people to start in shadow mode and read their own log before
 * enforcing anything. `log` prints one line per decision, which answers what
 * happened just now and not what a week of it amounts to. This answers the
 * question shadow mode is actually asking: if enforcement had been on, what
 * would have stopped, and was any of it work you wanted done.
 */

import type { AuditRecord } from '../audit/index.js';

export interface DecisionCount {
  readonly decision: string;
  readonly count: number;
}

export interface ServerSummary {
  readonly server: string;
  readonly calls: number;
  readonly results: number;
  readonly wouldStop: number;
  readonly costUsd: number;
}

export interface Summary {
  readonly records: number;
  readonly calls: number;
  readonly results: number;
  readonly toolLists: number;
  readonly evictions: number;
  /** When the first and last decision in the log were made. */
  readonly from?: string;
  readonly to?: string;
  /** What was actually done, by name. */
  readonly applied: readonly DecisionCount[];
  /**
   * Decisions where the policy wanted one thing and something else happened,
   * which in shadow mode is everything it would have stopped.
   */
  readonly wouldStop: readonly DecisionCount[];
  /** Judgments taken with no model behind them. */
  readonly unscreened: number;
  /** Screens that were attempted and failed, which is not the same. */
  readonly failed: number;
  readonly servers: readonly ServerSummary[];
  readonly requests: number;
  readonly inputTokens: number;
  readonly costUsd: number;
  /** Tool lists that changed since the server was first seen. */
  readonly toolListsChanged: number;
  /** Descriptions reported as steering the agent. */
  readonly steeringDescriptions: number;
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sorted(counts: Map<string, number>): DecisionCount[] {
  return [...counts.entries()]
    .map(([decision, count]) => ({ decision, count }))
    .sort((a, b) => b.count - a.count || (a.decision < b.decision ? -1 : 1));
}

/** Rounded the way a cost is written, so summing many small ones stays readable. */
function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export function summarise(records: readonly AuditRecord[]): Summary {
  const applied = new Map<string, number>();
  const wouldStop = new Map<string, number>();
  const servers = new Map<
    string,
    { calls: number; results: number; wouldStop: number; cost: number }
  >();

  let calls = 0;
  let results = 0;
  let toolLists = 0;
  let evictions = 0;
  let unscreened = 0;
  let failed = 0;
  let requests = 0;
  let inputTokens = 0;
  let costUsd = 0;
  let toolListsChanged = 0;
  let steeringDescriptions = 0;
  let from: string | undefined;
  let to: string | undefined;

  const forServer = (name: string) => {
    const known = servers.get(name);
    if (known !== undefined) {
      return known;
    }
    const fresh = { calls: 0, results: 0, wouldStop: 0, cost: 0 };
    servers.set(name, fresh);
    return fresh;
  };

  for (const record of records) {
    if (from === undefined || record.ts < from) {
      from = record.ts;
    }
    if (to === undefined || record.ts > to) {
      to = record.ts;
    }

    if (record.kind === 'eviction') {
      evictions += 1;
      continue;
    }

    const entry = forServer(record.server);

    if (record.kind === 'tool-list') {
      toolLists += 1;
      if (record.decision === 'changed') {
        toolListsChanged += 1;
      }
      steeringDescriptions += (record.steering ?? []).length;
      if (!record.screened) {
        unscreened += 1;
      }
      requests += record.requests ?? 0;
      inputTokens += record.input_tokens ?? 0;
      costUsd += record.cost_usd ?? 0;
      entry.cost += record.cost_usd ?? 0;
      continue;
    }

    if (record.kind === 'call') {
      calls += 1;
      entry.calls += 1;
    } else {
      results += 1;
      entry.results += 1;
    }

    tally(applied, record.decision);
    if (!record.screened) {
      unscreened += 1;
    }
    if (record.failure !== undefined) {
      failed += 1;
    }
    requests += record.requests ?? 0;
    inputTokens += record.input_tokens ?? 0;
    costUsd += record.cost_usd ?? 0;
    entry.cost += record.cost_usd ?? 0;

    // What the policy wanted, when it is not what happened. In shadow mode that
    // is the whole point: every one of these is something enforcement would
    // have stopped, and the user gets to look at it before turning it on.
    const intended = (record.intended as { kind?: string } | undefined)?.kind;
    const appliedKind = (record.applied as { kind?: string } | undefined)?.kind;
    if (intended !== undefined && intended !== appliedKind) {
      tally(wouldStop, intended);
      entry.wouldStop += 1;
    }
  }

  return {
    records: records.length,
    calls,
    results,
    toolLists,
    evictions,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    applied: sorted(applied),
    wouldStop: sorted(wouldStop),
    unscreened,
    failed,
    servers: [...servers.entries()]
      .map(([server, one]) => ({
        server,
        calls: one.calls,
        results: one.results,
        wouldStop: one.wouldStop,
        costUsd: round(one.cost),
      }))
      .sort(
        (a, b) => b.calls + b.results - (a.calls + a.results) || (a.server < b.server ? -1 : 1),
      ),
    requests,
    inputTokens,
    costUsd: round(costUsd),
    toolListsChanged,
    steeringDescriptions,
  };
}

const DID: Record<string, string> = {
  hold: 'held',
  block: 'blocked',
  quarantine: 'withheld',
  annotate: 'annotated',
  redact: 'redacted',
  forward: 'forwarded',
  pass: 'passed',
};

function day(ts: string): string {
  return ts.slice(0, 16).replace('T', ' ');
}

/** `1 call`, `2 calls`. Printed under someone's name, so it reads as written. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The summary as a person reads it. */
export function formatSummary(summary: Summary): string {
  if (summary.records === 0) {
    return 'Nothing recorded yet. Run a session and this will have something to say.';
  }
  const lines: string[] = [];
  const span =
    summary.from === undefined || summary.to === undefined
      ? ''
      : ` from ${day(summary.from)} to ${day(summary.to)}`;
  lines.push(
    `${count(summary.records, 'decision')}${span}: ${count(summary.calls, 'call')}, ${count(summary.results, 'result')}, ${count(summary.toolLists, 'tool list')}.`,
  );

  if (summary.wouldStop.length > 0) {
    const total = summary.wouldStop.reduce((sum, one) => sum + one.count, 0);
    lines.push('');
    lines.push(
      total === 1
        ? 'One would have been stopped if enforcement had been on, and was not:'
        : `${total} would have been stopped if enforcement had been on, and were not:`,
    );
    for (const one of summary.wouldStop) {
      lines.push(`  ${String(one.count).padStart(5)}  ${DID[one.decision] ?? one.decision}`);
    }
    lines.push('Read these with `agent-chaperone show <id>` before enforcing anything.');
  } else {
    lines.push('');
    lines.push('Nothing was held back from what actually happened.');
  }

  if (summary.applied.length > 0) {
    lines.push('');
    lines.push('What was done:');
    for (const one of summary.applied) {
      lines.push(`  ${String(one.count).padStart(5)}  ${DID[one.decision] ?? one.decision}`);
    }
  }

  if (summary.unscreened > 0 || summary.failed > 0) {
    lines.push('');
    // The two are different and the difference matters: one is a configuration
    // and the other is a screen that tried and could not.
    if (summary.unscreened > 0) {
      lines.push(
        `${count(summary.unscreened, 'decision')} ${summary.unscreened === 1 ? 'was' : 'were'} taken with no model asked.`,
      );
    }
    if (summary.failed > 0) {
      lines.push(
        `${count(summary.failed, 'screen')} ${summary.failed === 1 ? 'was' : 'were'} attempted and failed.`,
      );
    }
  }

  if (summary.toolListsChanged > 0 || summary.steeringDescriptions > 0) {
    lines.push('');
    if (summary.toolListsChanged > 0) {
      lines.push(
        `${count(summary.toolListsChanged, 'tool list')} ${summary.toolListsChanged === 1 ? 'differed' : 'differed'} from what that server first advertised.`,
      );
    }
    if (summary.steeringDescriptions > 0) {
      lines.push(
        `${count(summary.steeringDescriptions, 'tool description')} read as instructions to the agent.`,
      );
    }
  }

  if (summary.servers.length > 1) {
    lines.push('');
    lines.push('By server:');
    for (const one of summary.servers) {
      const stopped = one.wouldStop > 0 ? `, ${one.wouldStop} would have stopped` : '';
      lines.push(
        `  ${one.server}: ${count(one.calls, 'call')}, ${count(one.results, 'result')}${stopped}`,
      );
    }
  }

  lines.push('');
  lines.push(
    `${count(summary.requests, 'model request')}, ${count(summary.inputTokens, 'input token')}, $${summary.costUsd.toFixed(6)}.`,
  );
  return lines.join('\n');
}
