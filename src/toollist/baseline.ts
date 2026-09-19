/**
 * What a server said its tools were, the first time it said it.
 *
 * A user decides to trust a server once, against the tools it advertised that
 * day. Nothing makes that decision again. A server that later rewrites a
 * description, or grows a tool, is trading on a decision that was made about
 * something else, and the agent reads those descriptions as instructions about
 * what the tools are for.
 *
 * So the first list a server sends is recorded, and every later list is compared
 * against it. This is deterministic and needs no model: it does not ask whether
 * a description is malicious, only whether it is the one you agreed to.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../audit/index.js';

export const TOOLS_DIRECTORY = 'tools';
export const FILE_MODE = 0o600;
export const DIRECTORY_MODE = 0o700;

/** One tool, reduced to the parts a change would matter in. */
export interface ToolPrint {
  readonly name: string;
  /** Digest of the description and the input schema together. */
  readonly digest: string;
}

/**
 * The key a judgment is stored under.
 *
 * Name and digest together, not either alone. The digest covers the description
 * and the schema but not the name, and the name is part of what the screen is
 * shown, so the same description under two names is two questions. Keying by
 * name alone is worse still: a server can advertise the same name twice.
 */
export function judgmentKey(name: string, digest: string): string {
  return `${name}\u0000${digest}`;
}

export interface Baseline {
  readonly server: string;
  /** When `tools` was learned. It does not move when a judgment is remembered. */
  readonly recordedAt: string;
  /**
   * What this server advertised the first time, and the only thing later lists
   * are compared against. Rewriting it on every connection would make the record
   * last-seen rather than first-seen, so a tampered description would be
   * reported once and then become the expectation.
   */
  readonly tools: readonly ToolPrint[];
  /**
   * What the screen concluded about a description, by `judgmentKey`. Separate
   * from `tools` because it is a cache and not evidence: it can be written
   * freely without touching what is being compared, and a description a server
   * flips back and forth reuses its earlier answer rather than paying twice.
   */
  readonly judgments: Readonly<Record<string, number>>;
}

export type ToolChange =
  | { readonly kind: 'added'; readonly name: string }
  | { readonly kind: 'removed'; readonly name: string }
  | { readonly kind: 'changed'; readonly name: string };

/**
 * A tool as it arrives in a `tools/list` result.
 *
 * Everything is optional because this is a peer's data, not ours: a server that
 * omits a description or sends a number where a string belongs must not take the
 * proxy down, it must simply be recorded as what it sent.
 */
export interface AdvertisedTool {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly inputSchema?: unknown;
}

/**
 * Stable JSON, so a server that reorders its schema keys does not read as a
 * change. Only the shape matters, not how it was serialised on the day.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function digestOf(tool: AdvertisedTool): string {
  return createHash('sha256')
    .update(
      canonical({ description: tool.description ?? null, inputSchema: tool.inputSchema ?? null }),
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * Read the tools out of a `tools/list` result.
 *
 * Anything without a usable name is dropped rather than recorded under a made-up
 * one: a nameless tool cannot be compared against anything, and inventing a key
 * for it would make every later list look changed.
 */
export function advertisedTools(result: unknown): AdvertisedTool[] {
  if (result === null || typeof result !== 'object') {
    return [];
  }
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.filter(
    (tool): tool is AdvertisedTool =>
      tool !== null &&
      typeof tool === 'object' &&
      typeof (tool as { name?: unknown }).name === 'string',
  );
}

export function printTools(tools: readonly AdvertisedTool[]): ToolPrint[] {
  return tools
    .map((tool) => ({ name: String(tool.name), digest: digestOf(tool) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * What changed between the list that was recorded and the one that arrived.
 *
 * A server that sends the same tool twice is reported once. The comparison is by
 * name, because that is what a client's configuration and a policy's allow list
 * both refer to.
 */
export function compareTools(
  recorded: readonly ToolPrint[],
  current: readonly ToolPrint[],
): ToolChange[] {
  const before = new Map(recorded.map((one) => [one.name, one.digest]));
  const after = new Map(current.map((one) => [one.name, one.digest]));
  const changes: ToolChange[] = [];

  for (const [name, digest] of after) {
    const was = before.get(name);
    if (was === undefined) {
      changes.push({ kind: 'added', name });
    } else if (was !== digest) {
      changes.push({ kind: 'changed', name });
    }
  }
  for (const name of before.keys()) {
    if (!after.has(name)) {
      changes.push({ kind: 'removed', name });
    }
  }
  return changes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * A file name for a server.
 *
 * A server is named by whoever wrote the client's configuration, and since a URL
 * upstream answers to its host it can carry dots, slashes and worse. The readable
 * part is kept for someone listing the directory, and a digest of the real name
 * carries the uniqueness, so two servers cannot collide by being sanitised into
 * each other and nothing can escape the directory.
 */
export function baselineFileName(server: string): string {
  const readable = server
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 48);
  const digest = createHash('sha256').update(server).digest('hex').slice(0, 12);
  return `${readable.length > 0 ? readable : 'server'}.${digest}.json`;
}

export function toolsDirectory(env?: NodeJS.ProcessEnv): string {
  return join(stateDirectory(env), TOOLS_DIRECTORY);
}

/** A probability as it must be to be trusted from disk. */
function validProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Read the record, keeping only what is well formed.
 *
 * This file is on disk and can be edited, truncated or written by an older
 * version. A field that is not what it claims to be is dropped rather than
 * trusted: a judgment that is not a probability would otherwise retire that
 * description from screening forever, which is the quietest possible failure.
 */
export function readBaseline(server: string, env?: NodeJS.ProcessEnv): Baseline | undefined {
  const path = join(toolsDirectory(env), baselineFileName(server));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Partial<Baseline>;
  if (!Array.isArray(record.tools)) {
    return undefined;
  }
  const tools = record.tools.filter(
    (tool): tool is ToolPrint =>
      tool !== null &&
      typeof tool === 'object' &&
      typeof (tool as ToolPrint).name === 'string' &&
      typeof (tool as ToolPrint).digest === 'string',
  );
  const judgments: Record<string, number> = {};
  // A record written by 0.2.0 has no judgments at all. That is not corruption:
  // it re-learns nothing and simply has no cached answers yet.
  const written: unknown = record.judgments;
  if (written !== null && typeof written === 'object') {
    for (const [key, value] of Object.entries(written as Record<string, unknown>)) {
      if (validProbability(value)) {
        judgments[key] = value;
      }
    }
  }
  return {
    server,
    recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : '',
    tools,
    judgments,
  };
}

function writeRecord(server: string, baseline: Baseline, env?: NodeJS.ProcessEnv): void {
  const directory = toolsDirectory(env);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const path = join(directory, baselineFileName(server));
  // Through a temporary file and a rename, so a process that dies partway leaves
  // the previous record intact rather than a truncated one that would read as
  // every tool having changed. The name carries the pid so two processes writing
  // at once cannot share a temporary file.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: FILE_MODE });
  renameSync(temporary, path);
}

/**
 * Record what this server advertises as the list to expect from now on.
 *
 * Only for a server with no record, and for `trust`. Everything else remembers
 * judgments instead, because the value of this file is that it holds what was
 * advertised first.
 */
export function learnBaseline(
  server: string,
  tools: readonly ToolPrint[],
  now: () => Date = () => new Date(),
  env?: NodeJS.ProcessEnv,
): Baseline {
  const baseline: Baseline = {
    server,
    recordedAt: now().toISOString(),
    tools,
    judgments: {},
  };
  writeRecord(server, baseline, env);
  return baseline;
}

/**
 * How many judgments one server's record may hold.
 *
 * A server that rewrites a description on every connection would otherwise grow
 * this file without bound. Well past any real tool list, and the oldest go
 * first, which for a server behaving normally are the ones it no longer
 * advertises.
 */
export const MAX_JUDGMENTS = 512;

/**
 * Remember what the screen concluded, without touching what is being compared.
 *
 * `tools` and `recordedAt` are left exactly as they were. A judgment is a cache
 * entry; writing one must never move the thing a later list is measured against,
 * or the notice would say "first advertised" about yesterday.
 */
export function rememberJudgments(
  server: string,
  judgments: Readonly<Record<string, number>>,
  keep: ReadonlySet<string>,
  env?: NodeJS.ProcessEnv,
): void {
  const existing = readBaseline(server, env);
  if (existing === undefined) {
    return;
  }
  const merged: Record<string, number> = {};
  for (const [key, value] of Object.entries({ ...existing.judgments, ...judgments })) {
    // Keys for descriptions this server no longer advertises are dropped, so the
    // file tracks the server rather than its whole history.
    if (keep.has(key) && validProbability(value)) {
      merged[key] = value;
    }
  }
  const trimmed = Object.entries(merged).slice(-MAX_JUDGMENTS);
  writeRecord(server, { ...existing, judgments: Object.fromEntries(trimmed) }, env);
}

/**
 * Forget what a server advertised, so the next list it sends is learned fresh.
 *
 * This is what accepting a change means. Rewriting the record from a list the
 * server is not currently offering would mean trusting a description nobody has
 * seen, so the record is dropped instead and rebuilt from the next connection.
 *
 * Returns whether there was anything to forget.
 */
export function forgetBaseline(server: string, env?: NodeJS.ProcessEnv): boolean {
  const path = join(toolsDirectory(env), baselineFileName(server));
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
