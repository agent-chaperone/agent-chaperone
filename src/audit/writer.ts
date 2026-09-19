/**
 * Appending one line per decision, without getting in the way of the session.
 *
 * The proxy sits between an agent and its tools, so nothing here may block it or
 * bring it down. A log that cannot be written is reported once and then stops
 * trying: a firewall that refuses to relay because its disk filled up has turned
 * a full disk into an outage.
 *
 * The directory and the file are created for the owner alone. The log holds what
 * an agent asked for and what its tools returned, redacted but not harmless, and
 * on a shared machine the default umask is not a decision anyone made.
 */

import { appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Judgment } from '../screening/index.js';
import { sessionFileName, sessionsDirectory } from './paths.js';
import { toEvictionRecord, toRecord, toToolListRecord, type AuditRecord } from './record.js';

/** Owner read and write, and nothing for anyone else. */
export const FILE_MODE = 0o600;
export const DIRECTORY_MODE = 0o700;

export interface AuditLogOptions {
  /** Defaults to the session file under the user's state directory. */
  readonly path?: string;
  readonly now?: () => Date;
  /** False keeps the judgments and drops the arguments and the result text. */
  readonly storeContent?: boolean;
  /** Said once, when the log cannot be written. */
  readonly onProblem?: (message: string) => void;
}

export interface AuditLog {
  readonly path: string;
  write(judgment: Judgment): void;
  /**
   * Record a pending request dropped to keep the correlator in bounds, so the
   * unpaired response that follows can be explained after the fact.
   */
  writeEviction(input: {
    readonly server: string;
    readonly id: unknown;
    readonly method: string;
    readonly reason: 'count' | 'bytes';
  }): void;
  /** The records written so far, for a caller that wants them without re-reading the file. */
  readonly written: number;
}

export function sessionPath(startedAt: Date, pid: number, env?: NodeJS.ProcessEnv): string {
  return join(sessionsDirectory(env), sessionFileName(startedAt, pid));
}

export function createAuditLog(options: AuditLogOptions = {}): AuditLog {
  const now = options.now ?? ((): Date => new Date());
  const storeContent = options.storeContent ?? true;
  const report = options.onProblem ?? ((): void => undefined);
  const path = options.path ?? sessionPath(now(), process.pid);

  let written = 0;
  let broken = false;

  const fail = (error: unknown): void => {
    broken = true;
    const message = error instanceof Error ? error.message : String(error);
    report(`the audit log could not be written, so this session is not being recorded: ${message}`);
  };

  // Created on the first write rather than up front, so a session that screens
  // nothing leaves nothing behind.
  let ready = false;
  const prepare = (): void => {
    if (ready) {
      return;
    }
    mkdirSync(join(path, '..'), { recursive: true, mode: DIRECTORY_MODE });
    // Opened explicitly so the mode applies on creation. Handing the mode to
    // appendFile only works if the file is not already there, and a file created
    // with a permissive umask and fixed afterwards was readable in between.
    closeSync(openSync(path, 'a', FILE_MODE));
    ready = true;
  };

  // Once, and then never again. Without this the proxy would pay for a failing
  // filesystem call on every message it screens, which is the cost the header
  // comment says a broken log must not impose on a session.
  const append = (record: AuditRecord): void => {
    if (broken) {
      return;
    }
    try {
      prepare();
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
      written += 1;
    } catch (error) {
      fail(error);
    }
  };

  return {
    path,
    get written() {
      return written;
    },
    write(judgment: Judgment): void {
      append(
        judgment.side === 'tool-list'
          ? toToolListRecord(judgment, { now, storeContent })
          : toRecord(judgment, { now, storeContent }),
      );
    },
    writeEviction(input): void {
      append(toEvictionRecord(input, { now, storeContent }));
    },
  };
}
