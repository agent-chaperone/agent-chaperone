/**
 * The agents a hook can be called from, and how each one is answered.
 *
 * The screens are the same everywhere. What differs is the contract around
 * them, and three differences decide what a hook can do on a given agent:
 * whether a pre-tool hook can ask the person or only refuse, whether a
 * post-tool hook can replace what the model reads or only add text next to it,
 * and which of the agent's tools the hook is sent at all.
 *
 * The agent is read from the payload rather than from configuration, because
 * the same command line is run by more than one of them. Cursor runs the hooks
 * in Claude Code's settings files by default and VS Code does when asked to,
 * and both send their own payload shape to a command written for Claude Code.
 * A command that assumed Claude Code there would answer in a shape the agent
 * ignores, and an ignored answer lets the call through.
 */

export type Client = 'claude' | 'cursor' | 'vscode' | 'hermes';

export const CLIENTS: readonly Client[] = ['claude', 'cursor', 'vscode', 'hermes'];

export function isClient(value: string): value is Client {
  return (CLIENTS as readonly string[]).includes(value);
}

/** Hermes names its events after the hook, and its post payload carries the result under `extra`. */
const HERMES_EVENTS = new Set(['pre_tool_call', 'post_tool_call']);
/** Cursor's events are camelCase, and its payload names the version that sent it. */
const CURSOR_EVENTS = new Set(['preToolUse', 'postToolUse', 'postToolUseFailure']);

/**
 * Which agent sent a parsed payload.
 *
 * VS Code sends Claude Code's event names with Claude Code's field names, and
 * is told apart by the `timestamp` it adds and the `permission_mode` it leaves
 * out. Anything unrecognised is read as Claude Code, which is what every hook
 * before this one assumed.
 */
export function clientOf(payload: Record<string, unknown>): Client {
  const event = payload['hook_event_name'];
  if (typeof event === 'string' && HERMES_EVENTS.has(event)) {
    return 'hermes';
  }
  if (
    typeof payload['cursor_version'] === 'string' ||
    (typeof event === 'string' && CURSOR_EVENTS.has(event))
  ) {
    return 'cursor';
  }
  if (payload['timestamp'] !== undefined && payload['permission_mode'] === undefined) {
    return 'vscode';
  }
  return 'claude';
}

/**
 * Tools an agent's hook should leave to the proxy.
 *
 * Every agent here also fires its hooks for MCP tools, and an MCP server that is
 * wrapped is already screened on its connection. Screening it twice costs two
 * requests and records two decisions about one call. Claude Code is left out:
 * its matchers are exact names, so an MCP tool only arrives when someone named
 * it, and that choice is theirs.
 */
function isMcpTool(client: Client, tool: string): boolean {
  if (client === 'cursor') {
    return tool.startsWith('MCP:');
  }
  if (client === 'vscode' || client === 'hermes') {
    return tool.startsWith('mcp_');
  }
  return false;
}

/**
 * VS Code's built-in tools worth screening before they run: the ones that run a
 * command, change a file or send something out.
 */
export const VSCODE_PRE_TOOLS: ReadonlySet<string> = new Set([
  'run_in_terminal',
  'send_to_terminal',
  'create_and_run_task',
  'replace_string_in_file',
  'multi_replace_string_in_file',
  'insert_edit_into_file',
  'create_file',
  'apply_patch',
  'edit_notebook_file',
  'fetch_webpage',
  'run_vscode_command',
  'install_extension',
  'run_playwright_code',
  'open_browser_page',
  'navigate_page',
]);

/** VS Code's built-in tools whose results bring in text the user did not write. */
export const VSCODE_POST_TOOLS: ReadonlySet<string> = new Set([
  'run_in_terminal',
  'send_to_terminal',
  'get_terminal_output',
  'read_file',
  'grep_search',
  'fetch_webpage',
  'github_repo',
  'github_text_search',
  'read_page',
  'read_notebook_cell_output',
  'run_playwright_code',
]);

/**
 * Hermes's tools worth screening before they run. The plugin carries the same
 * two lists so it does not start a process for a tool nobody screens, and a test
 * keeps them identical.
 */
export const HERMES_PRE_TOOLS: ReadonlySet<string> = new Set([
  'terminal',
  'process_manage',
  'write_file',
  'patch',
  'execute_code',
  'web_extract',
  'browser_navigate',
  'browser_exec',
  'browser_cdp',
]);

/** Hermes's tools whose results bring in text the user did not write. */
export const HERMES_POST_TOOLS: ReadonlySet<string> = new Set([
  'terminal',
  'process_manage',
  'read_file',
  'search_files',
  'web_search',
  'web_extract',
  'execute_code',
  'browser_snapshot',
  'browser_console',
  'browser_exec',
]);

/**
 * Whether a hook should screen this tool at all.
 *
 * VS Code reads a matcher and then ignores it, so every hook runs for every
 * tool, including the ones that only list a directory. The list is applied here
 * instead. Hermes's list is applied here as well as in the plugin, so a shell
 * hook registered without a matcher costs nothing on tools nobody screens.
 * Claude Code and Cursor honour their matchers, and the person who wrote the
 * matcher decides.
 */
export function screensTool(client: Client, side: 'pre' | 'post', tool: string): boolean {
  if (isMcpTool(client, tool)) {
    return false;
  }
  if (client === 'vscode') {
    return (side === 'pre' ? VSCODE_PRE_TOOLS : VSCODE_POST_TOOLS).has(tool);
  }
  if (client === 'hermes') {
    return (side === 'pre' ? HERMES_PRE_TOOLS : HERMES_POST_TOOLS).has(tool);
  }
  return true;
}

/**
 * Whether a post-tool hook on this agent can replace what the model reads.
 *
 * Claude Code can, except on the event a failed tool fires. Hermes can through
 * its plugin, whose result transform takes any string. Cursor replaces MCP
 * results only, which the proxy already covers, and VS Code cannot replace a
 * result at all: a block there appends a note after the original, which the
 * model still reads. On those two, a result judged unsafe is annotated and the
 * notice says it could not be withheld.
 */
export function canReplace(client: Client, failed: boolean): boolean {
  if (client === 'claude') {
    return !failed;
  }
  return client === 'hermes';
}
