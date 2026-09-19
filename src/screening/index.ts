/**
 * Screening: the layer that decides what the proxy does with a message.
 *
 * The rules, the screens, the backend and the policy are all pure or
 * self-contained. This is where they are put in the path of real traffic.
 */

export {
  MAX_SCREENED_BLOCKS,
  ask,
  createScreeningGate,
  onCallFailure,
  onResultFailure,
  onTruncated,
  onUnreadable,
  stronger,
} from './gate.js';
export {
  RESOURCE_READ,
  TOOL_CALL,
  readResultText,
  readToolCall,
  toolError,
  withBanner,
  withText,
} from './mcp.js';
export {
  annotated,
  annotatedBanner,
  blockedCall,
  heldCall,
  partlyUnscreened,
  partlyUnscreenedBanner,
  quarantined,
  withheldSecret,
} from './notices.js';

export type {
  BackendUsage,
  CallJudgment,
  Judgment,
  ResultJudgment,
  ToolListJudgment,
  ScreeningOptions,
} from './gate.js';
export type { ResultShape, ResultText, ToolCall } from './mcp.js';
