/**
 * The audit log: one line per screened message, and the commands that read it.
 *
 * This is what makes a threshold tunable on a user's own traffic rather than
 * guessed, which is the whole reason shadow mode is the default.
 */

export { sessionsDirectory, sessionFileName, stateDirectory } from './paths.js';
export { PRICE_PER_MTOK, costOf, formatRecord, toRecord } from './record.js';
export { DIRECTORY_MODE, FILE_MODE, createAuditLog, sessionPath } from './writer.js';
export { toEvictionRecord } from './record.js';
export {
  DEFAULT_LOG_LIMIT,
  currentSession,
  findRecord,
  followRecords,
  parseRecords,
  readRecords,
  recentRecords,
  sessionFiles,
} from './read.js';

export type {
  AuditContent,
  AuditRecord,
  EvictionRecord,
  JudgmentRecord,
  RecordOptions,
} from './record.js';
export type { AuditLog, AuditLogOptions } from './writer.js';
export type { FollowOptions } from './read.js';
