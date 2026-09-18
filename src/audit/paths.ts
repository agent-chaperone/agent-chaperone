/**
 * Where the log lives.
 *
 * One file per session, under the user's state directory. Sessions rather than
 * one growing file because the thing a user wants to read is almost always what
 * just happened, and because a file that is only ever appended to by one process
 * needs no locking to stay readable.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIRECTORY = 'agent-chaperone';
export const SESSIONS_DIRECTORY = 'sessions';

/** The directory the log, the held calls and the recorded task all live under. */
export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  // `||` rather than `??`: the XDG spec says an empty value means unset, and an
  // exported-but-empty variable is what a shell hands a child process. Falling
  // through to `join('', ...)` would make the whole path relative, and the log
  // would be written into whatever directory the client happened to launch the
  // server in, which is normally the user's project.
  const base = env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state');
  return join(base, STATE_DIRECTORY);
}

export function sessionsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDirectory(env), SESSIONS_DIRECTORY);
}

/**
 * A name that sorts by when the session started and cannot collide with another
 * process starting in the same second.
 */
export function sessionFileName(startedAt: Date, pid: number): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${String(pid)}.jsonl`;
}
