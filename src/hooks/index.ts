/**
 * Hooks: the same screens, for the tools a proxy never sees.
 *
 * A client's built-in shell, file edits and web fetches do not travel over MCP.
 * On the clients people use, those are where most of the damage lives.
 */

export {
  POST_TOOL_USE,
  POST_TOOL_USE_FAILURE,
  PRE_TOOL_USE,
  annotateOutput,
  eventOf,
  outputText,
  postResponse,
  preResponse,
  readPayload,
  replaceOutput,
  survivingText,
} from './payload.js';
export { BUILT_IN_SERVER, runPostHook, runPreHook } from './run.js';

export type { HookCall, OutputText, PostResponse, PreResponse, TextPath } from './payload.js';
export type { HookOptions } from './run.js';
