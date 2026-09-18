/**
 * Reading the log back.
 *
 * A session file is appended to by a running process, so a reader has to cope
 * with a last line that is only half there. A record that will not parse is
 * skipped rather than fatal: one torn line at the end of a file being written
 * right now is the ordinary case, not a corrupted log.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDirectory } from './paths.js';
import type { AuditRecord } from './record.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Records in a file, skipping any line that is not one. */
export function parseRecords(text: string): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed['id'] === 'string') {
        out.push(parsed as unknown as AuditRecord);
      }
    } catch {
      // A half-written last line, which is what a file being appended to looks
      // like from outside.
      continue;
    }
  }
  return out;
}

export function readRecords(path: string): AuditRecord[] {
  try {
    return parseRecords(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Session files, newest last.
 *
 * The sort is here because `readdir` is ordered on some filesystems and not on
 * others, which is also why no test can see it on a machine where it already is.
 * Nothing that matters depends on it any more: both readers sort by the time a
 * decision was made, which is a property of the records rather than of the
 * directory.
 */
export function sessionFiles(env?: NodeJS.ProcessEnv): string[] {
  const directory = sessionsDirectory(env);
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

export function currentSession(env?: NodeJS.ProcessEnv): string | undefined {
  return sessionFiles(env).at(-1);
}

/** How many decisions `log` shows by default, newest last. */
export const DEFAULT_LOG_LIMIT = 200;

/**
 * Records from every session, oldest first.
 *
 * Not just the newest file: a client normally wraps several servers at once and
 * each is its own process with its own session, so reading one of them would
 * hide the others. Sorted by when each decision was made, which is the order a
 * person watching their own traffic expects.
 */
export function recentRecords(limit = DEFAULT_LOG_LIMIT, env?: NodeJS.ProcessEnv): AuditRecord[] {
  const all = sessionFiles(env).flatMap((path) => readRecords(path));
  all.sort((one, two) => (one.ts < two.ts ? -1 : one.ts > two.ts ? 1 : 0));
  return limit <= 0 ? all : all.slice(-limit);
}

/**
 * The record with this id, newest first.
 *
 * Decided by when each decision was made rather than by the order the directory
 * happens to list its files in, which is sorted on some filesystems and not on
 * others. An id a user just read off their terminal is almost always from the
 * session they are still in, and that has to be true wherever it runs.
 */
export function findRecord(id: string, env?: NodeJS.ProcessEnv): AuditRecord | undefined {
  const matches = sessionFiles(env)
    .flatMap((path) => readRecords(path))
    .filter((record) => record.id === id);
  matches.sort((one, two) => (one.ts < two.ts ? -1 : one.ts > two.ts ? 1 : 0));
  return matches.at(-1);
}

export interface FollowOptions {
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Keep printing decisions as they are made.
 *
 * Polled rather than watched. A session file is appended to by another process,
 * sometimes several, and file watching reports directory and rename events
 * differently on every platform; a poll that re-reads and skips what it has
 * already seen is the same answer everywhere and is never wrong about ordering.
 */
export async function followRecords(
  onRecord: (record: AuditRecord) => void,
  options: FollowOptions = {},
): Promise<void> {
  const interval = options.intervalMs ?? 250;
  const seen = new Set<string>();
  for (const record of recentRecords(0, options.env)) {
    seen.add(record.id);
    onRecord(record);
  }
  const stopped = (): boolean => options.signal?.aborted === true;
  while (!stopped()) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (stopped()) {
      return;
    }
    for (const record of recentRecords(0, options.env)) {
      if (!seen.has(record.id)) {
        seen.add(record.id);
        onRecord(record);
      }
    }
  }
}
