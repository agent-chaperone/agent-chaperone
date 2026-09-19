/**
 * The screens: a tool call or a tool result turned into the exact request the
 * benchmark measured, and the answers turned back into what the rules read.
 */

export {
  CALL_SEVERITY,
  DESCRIPTION_STEERS,
  DESTRUCTIVE,
  EXFILTRATION,
  EXPOSES_SECRET,
  INSTRUCTS_READER,
  NO_BLOCK,
  OFF_TASK,
  POLICY_VIOLATION,
  POSTRESULT_MEASURED,
  PRECALL_MEASURED,
  RESULT_SEVERITY,
  SECRET_IN_ARGS,
  TOOLLIST_UNMEASURED,
  whichBlock,
} from './questions.js';
export { buildPreCallScreen, noulOf, readCallAnswers, scoreOf } from './precall.js';
export {
  DEFAULT_MAX_STATE_CHARS,
  MAX_TOOL_CHARS,
  buildPostResultScreens,
  chunkBlocks,
  mergeResultAnswers,
  readResultAnswers,
} from './postresult.js';

export {
  MAX_DESCRIPTION_CHARS,
  buildToolListScreen,
  describableText,
  readToolListAnswers,
} from './toollist.js';
export type { ToolListAnswers, ToolListScreen, ToolListState } from './toollist.js';

export type { PreCallInput, PreCallScreen, PreCallState, PreCallTool } from './precall.js';
export type {
  PostResultInput,
  PostResultScreen,
  PostResultState,
  PostResultTool,
  StateHiddenRegion,
} from './postresult.js';
