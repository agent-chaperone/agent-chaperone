/**
 * What the user asked the agent to do, so a screen can ask whether a call has
 * anything to do with it.
 *
 * The off-task question is the only one that needs something no tool call
 * contains. Without a task it is never sent, which is why it has never fired:
 * nothing has ever recorded one.
 *
 * Scoped to a directory rather than to the machine. A task is what someone is
 * doing in one project, and a task set while working on one repository must not
 * decide whether a call is off topic in another.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../audit/index.js';

export const TASKS_DIRECTORY = 'tasks';
export const FILE_MODE = 0o600;
export const DIRECTORY_MODE = 0o700;

/**
 * How long a task is believed.
 *
 * A stale task is worse than none. It would have the screen judging today's
 * calls against last week's intent, and the answer would be confidently wrong
 * rather than absent. Long enough to cover a working day, short enough that one
 * forgotten task does not follow someone into next week.
 */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** The longest task text that is kept, since it is sent with every screened call. */
export const MAX_TASK_CHARS = 2_000;

export interface Task {
  readonly text: string;
  readonly setAt: string;
  readonly expiresAt: string;
  /** The directory this was set for, for `task` to print back. */
  readonly directory: string;
}

export function tasksDirectory(env?: NodeJS.ProcessEnv): string {
  return join(stateDirectory(env), TASKS_DIRECTORY);
}

/**
 * A file name for a directory.
 *
 * A digest rather than the path itself: a path is not a file name, it is
 * unbounded, and putting one in a name would leak what someone is working on to
 * anyone who can list the directory.
 */
export function taskFileName(directory: string): string {
  return `${createHash('sha256').update(directory).digest('hex').slice(0, 32)}.json`;
}

export function readTask(
  directory: string,
  now: () => Date = () => new Date(),
  env?: NodeJS.ProcessEnv,
): Task | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(tasksDirectory(env), taskFileName(directory)), 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const task = parsed as Partial<Task>;
  if (typeof task.text !== 'string' || typeof task.expiresAt !== 'string') {
    return undefined;
  }
  // An expired task is not a task. Returning it would have the screen judging
  // against intent the user has moved on from.
  if (Date.parse(task.expiresAt) <= now().getTime()) {
    return undefined;
  }
  return {
    text: task.text,
    setAt: typeof task.setAt === 'string' ? task.setAt : '',
    expiresAt: task.expiresAt,
    directory: typeof task.directory === 'string' ? task.directory : directory,
  };
}

export function writeTask(
  directory: string,
  text: string,
  now: () => Date = () => new Date(),
  ttlMs: number = DEFAULT_TTL_MS,
  env?: NodeJS.ProcessEnv,
): Task {
  const at = now();
  const task: Task = {
    text: text.slice(0, MAX_TASK_CHARS),
    setAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
    directory,
  };
  const folder = tasksDirectory(env);
  mkdirSync(folder, { recursive: true, mode: DIRECTORY_MODE });
  const path = join(folder, taskFileName(directory));
  // A task says what someone is working on, which is theirs. Written through a
  // rename so a reader never sees half of one.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: FILE_MODE });
  renameSync(temporary, path);
  return task;
}

/** Returns whether there was one to clear. */
export function clearTask(directory: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    rmSync(join(tasksDirectory(env), taskFileName(directory)));
    return true;
  } catch {
    return false;
  }
}
