/**
 * Screening: the layer that decides what the proxy does with a message.
 *
 * The rules, the screens, the backend and the policy are all pure or
 * self-contained. This is where they are put in the path of real traffic.
 */

export { createScreeningGate } from './gate.js';
export {
  RESOURCE_READ,
  TOOL_CALL,
  readResultText,
  readToolCall,
  toolError,
  withText,
} from './mcp.js';
export { annotated, blockedCall, heldCall, quarantined } from './notices.js';

export type {
  BackendUsage,
  CallJudgment,
  Judgment,
  ResultJudgment,
  ScreeningOptions,
} from './gate.js';
export type { ResultShape, ResultText, ToolCall } from './mcp.js';
