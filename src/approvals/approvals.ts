/**
 * Releasing a held call, once.
 *
 * A client has no interface for this, so the agent is told what was held and the
 * command that releases it, the user runs that command, and the agent retries.
 *
 * Two files, and the difference between them matters.
 *
 * A hold is written when a call is held: it is what the id in the agent's
 * message stands for. `approve` reads it rather than the audit log, so the flow
 * works when content was not stored and when the log could not be written at
 * all, and so the fingerprint never has to be kept in a record.
 *
 * An approval is what the gate spends. It is keyed by a fingerprint of the
 * server, the tool and the arguments as they arrived, not as they were redacted:
 * what gets forwarded on a hit is the original call, and two calls that differ
 * only inside a run redaction replaced are not the same call. A greedy secret
 * pattern swallows the path glued to a key, so fingerprinting the redacted form
 * let one approval release a different request to a different resource.
 *
 * Claiming is a rename, because a client normally runs several of these
 * processes at once and reading a file and then deleting it is two syscalls with
 * a gap in the middle. Whoever renames it has it; everyone else gets nothing.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestHash } from '../backends/index.js';
import { stateDirectory } from '../audit/index.js';

export const APPROVALS_DIRECTORY = 'approvals';
export const HOLDS_DIRECTORY = 'holds';
export const FILE_MODE = 0o600;
export const DIRECTORY_MODE = 0o700;

/**
 * Long enough for someone to read the agent's message, run the command and tell
 * the agent to try again. Short enough that a token nobody used stops mattering.
 */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** How long an id keeps meaning something. A held call nobody returned to is over. */
export const HOLD_TTL_MS = 24 * 60 * 60 * 1000;

export interface Hold {
  readonly id: string;
  readonly server: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly heldAt: string;
  readonly expiresAt: string;
  /**
   * The screen found a credential in this call's arguments. Carried so the
   * approved retry does not write to disk what the held original kept out of it:
   * approving releases the call, not the record of what was in it.
   */
  readonly credential?: boolean;
}

export interface Approval {
  readonly id: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  /**
   * The screen found a credential in this call's arguments. Carried so the
   * approved retry does not write to disk what the held original kept out of it:
   * approving releases the call, not the record of what was in it.
   */
  readonly credential?: boolean;
}

export function approvalsDirectory(env?: NodeJS.ProcessEnv): string {
  return join(stateDirectory(env), APPROVALS_DIRECTORY);
}

export function holdsDirectory(env?: NodeJS.ProcessEnv): string {
  return join(stateDirectory(env), HOLDS_DIRECTORY);
}

/**
 * What exactly is being approved: this server, this tool, these arguments.
 *
 * The arguments are the ones that arrived. They are hashed, never stored, and
 * the digest does not leave the machine, so nothing here carries a credential
 * anywhere; what it buys is that the call released is the call agreed to.
 */
export function callFingerprint(server: string, tool: string, args: unknown): string {
  // The canonical form is the one the recorded fixtures use: stable key order,
  // and nothing a caller can put in the arguments makes it throw.
  return requestHash({ server, tool, arguments: args }, 'approval-v1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown, fields: readonly string[]): boolean {
  return isRecord(value) && fields.every((field) => typeof value[field] === 'string');
}

function writeOwned(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: DIRECTORY_MODE });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: FILE_MODE });
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Being written right now, or edited by hand.
    return undefined;
  }
}

/** A name that cannot reach outside its directory, whatever produced it. */
function safeName(value: string): string | undefined {
  return /^[0-9a-f]{8,128}$/.test(value) ? value : undefined;
}

export interface HoldOptions {
  /** The screen found a credential in the arguments this hold is for. */
  readonly credential?: boolean;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Remember what this id stood for, so `approve` can act on it later. */
export function recordHold(
  id: string,
  server: string,
  tool: string,
  fingerprint: string,
  options: HoldOptions = {},
): Hold | undefined {
  const name = safeName(id);
  if (name === undefined) {
    return undefined;
  }
  const now = (options.now ?? ((): Date => new Date()))();
  const hold: Hold = {
    id,
    server,
    tool,
    fingerprint,
    heldAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (options.ttlMs ?? HOLD_TTL_MS)).toISOString(),
    ...(options.credential === true ? { credential: true } : {}),
  };
  try {
    writeOwned(join(holdsDirectory(options.env), `${name}.json`), hold);
  } catch {
    // The same rule the audit log follows: a session is not stopped because
    // something could not be written beside it.
    return undefined;
  }
  return hold;
}

export function readHold(id: string, options: HoldOptions = {}): Hold | undefined {
  const name = safeName(id);
  if (name === undefined) {
    return undefined;
  }
  const parsed = readJson(join(holdsDirectory(options.env), `${name}.json`));
  if (!strings(parsed, ['id', 'server', 'tool', 'fingerprint', 'heldAt', 'expiresAt'])) {
    return undefined;
  }
  const hold = parsed as unknown as Hold;
  const now = (options.now ?? ((): Date => new Date()))().toISOString();
  return hold.expiresAt > now ? hold : undefined;
}

export interface GrantOptions {
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Write the token for a hold. Granting twice is fine: it is the same call. */
export function grantApproval(hold: Hold, options: GrantOptions = {}): Approval | undefined {
  const name = safeName(hold.fingerprint);
  if (name === undefined) {
    return undefined;
  }
  const now = (options.now ?? ((): Date => new Date()))();
  const approval: Approval = {
    id: hold.id,
    tool: hold.tool,
    fingerprint: hold.fingerprint,
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    ...(hold.credential === true ? { credential: true } : {}),
  };
  writeOwned(join(approvalsDirectory(options.env), `${name}.json`), approval);
  return approval;
}

export interface TakeOptions {
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Spend the approval for this call, if there is one.
 *
 * Claimed by renaming before it is read, so two processes reaching the same
 * token cannot both spend it. Anything that goes wrong returns nothing, which
 * means the call stays held: a token that cannot be claimed cleanly is not a
 * token anyone should be relying on.
 */
export function takeApproval(fingerprint: string, options: TakeOptions = {}): Approval | undefined {
  const name = safeName(fingerprint);
  if (name === undefined) {
    return undefined;
  }
  const path = join(approvalsDirectory(options.env), `${name}.json`);
  const claimed = `${path}.${String(process.pid)}.claim`;
  try {
    renameSync(path, claimed);
  } catch {
    // Not there, or someone else got it first.
    return undefined;
  }

  try {
    const parsed = readJson(claimed);
    if (!strings(parsed, ['id', 'tool', 'fingerprint', 'grantedAt', 'expiresAt'])) {
      return undefined;
    }
    const approval = parsed as unknown as Approval;
    // The name is the key, and the contents claim one too. A token whose own
    // fingerprint disagrees with where it was filed is not one to act on.
    if (approval.fingerprint !== fingerprint) {
      return undefined;
    }
    const now = (options.now ?? ((): Date => new Date()))().toISOString();
    return approval.expiresAt > now ? approval : undefined;
  } finally {
    rmSync(claimed, { force: true });
  }
}

/**
 * Tokens and holds nobody returned to.
 *
 * Also the claims left behind by a process that died between renaming a token
 * and deleting it, which would otherwise sit in the directory forever.
 */
export function sweepApprovals(options: TakeOptions = {}): number {
  const now = (options.now ?? ((): Date => new Date()))().toISOString();
  let removed = 0;

  for (const directory of [approvalsDirectory(options.env), holdsDirectory(options.env)]) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      if (name.endsWith('.claim')) {
        rmSync(path, { force: true });
        removed += 1;
        continue;
      }
      if (!name.endsWith('.json')) {
        continue;
      }
      const parsed = readJson(path);
      const expiresAt = isRecord(parsed) ? parsed['expiresAt'] : undefined;
      if (typeof expiresAt !== 'string' || expiresAt <= now) {
        rmSync(path, { force: true });
        removed += 1;
      }
    }
  }
  return removed;
}
