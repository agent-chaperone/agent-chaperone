/**
 * Approvals: releasing one held call, once.
 *
 * The file the `approve` command writes and the gate spends.
 */

export {
  APPROVALS_DIRECTORY,
  DEFAULT_TTL_MS,
  DIRECTORY_MODE,
  FILE_MODE,
  HOLDS_DIRECTORY,
  HOLD_TTL_MS,
  approvalsDirectory,
  callFingerprint,
  grantApproval,
  holdsDirectory,
  readHold,
  recordHold,
  sweepApprovals,
  takeApproval,
} from './approvals.js';

export type { Approval, GrantOptions, Hold, HoldOptions, TakeOptions } from './approvals.js';
