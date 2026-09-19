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

export interface Baseline {
  readonly server: string;
  readonly recordedAt: string;
  readonly tools: readonly ToolPrint[];
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

export function readBaseline(server: string, env?: NodeJS.ProcessEnv): Baseline | undefined {
  const path = join(toolsDirectory(env), baselineFileName(server));
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Baseline;
    // A file that exists but says nothing usable is treated as no baseline, so a
    // corrupted record re-learns rather than reporting every tool as changed.
    return Array.isArray(parsed.tools) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record a list as the one this server is expected to advertise.
 *
 * Written through a temporary file and renamed, so a process that dies partway
 * leaves the previous baseline intact rather than a half-written one that would
 * read as every tool having changed.
 */
export function writeBaseline(
  server: string,
  tools: readonly ToolPrint[],
  now: () => Date = () => new Date(),
  env?: NodeJS.ProcessEnv,
): Baseline {
  const directory = toolsDirectory(env);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const baseline: Baseline = { server, recordedAt: now().toISOString(), tools };
  const path = join(directory, baselineFileName(server));
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: FILE_MODE });
  renameSync(temporary, path);
  return baseline;
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
