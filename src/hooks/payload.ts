/**
 * Reading what a client hands a hook, and building what it expects back.
 *
 * A proxy never sees a client's built-in tools: the shell, file edits and web
 * fetches do not travel over MCP, and on the clients people actually use those
 * are where most of the damage lives. A hook is the only seam that reaches them.
 *
 * Three things about the contract shape everything here, all taken from the
 * documented behaviour rather than assumed.
 *
 * A pre-tool hook can deny a call outright, or ask the user to confirm it. Ask
 * is what a hold should be: the person is already at the keyboard, and telling
 * them to go and run a command in another terminal when the client can put the
 * question in front of them is worse. Forwarding returns no decision at all
 * rather than `allow`, because allow skips the permission prompts the user set
 * up for themselves, and a screening tool that quietly auto-approves things is
 * not one anybody asked for.
 *
 * A post-tool hook can replace what the model reads, but the replacement has to
 * match the tool's own output shape, and a value that does not match is ignored
 * without complaint while the original reaches the model. Silently failing open
 * is the one outcome this project cannot have, so the replacement is built from
 * the shape that arrived rather than from a table of tools.
 *
 * A failed tool fires a different event, and that event can only add context. So
 * a failed call can be annotated and never withheld, and the notice says so
 * rather than implying the content was kept back.
 */

export const PRE_TOOL_USE = 'PreToolUse';
export const POST_TOOL_USE = 'PostToolUse';
export const POST_TOOL_USE_FAILURE = 'PostToolUseFailure';

export interface HookCall {
  readonly tool: string;
  readonly input: unknown;
  /** Only on a post-tool payload: what the tool returned. */
  readonly response?: unknown;
  /** Which event this payload came from, because what may be returned depends on it. */
  readonly event?: string;
  /**
   * The session the client is running, for a caller that wants to tie a
   * judgment to one. The audit record has no field for it, so nothing here
   * writes it anywhere.
   */
  readonly session?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The call a payload describes, or undefined when it does not describe one.
 *
 * Tolerant in the same way the proxy is: a payload naming no tool is not
 * something to guess at. What happens next is the mode's decision, not this
 * function's.
 */
export function readPayload(text: string): HookCall | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed['tool_name'] !== 'string' || parsed['tool_name'] === '') {
    return undefined;
  }
  const event = parsed['hook_event_name'];
  // A failed tool carries its output in a top-level `error` string instead of in
  // `tool_response`. Same text, same author, same reason to read it.
  const response = Object.hasOwn(parsed, 'tool_response')
    ? { response: parsed['tool_response'] }
    : Object.hasOwn(parsed, 'error')
      ? { response: parsed['error'] }
      : {};
  return {
    tool: parsed['tool_name'],
    input: parsed['tool_input'],
    ...response,
    ...(typeof event === 'string' && event !== '' ? { event } : {}),
    ...(typeof parsed['session_id'] === 'string' ? { session: parsed['session_id'] } : {}),
  };
}

/**
 * Which event a payload came from, without needing the rest of it to be valid.
 *
 * Read on its own because the answer has to name the event it answers, and a
 * hook that cannot load its policy still has to answer.
 */
export function eventOf(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const event = parsed['hook_event_name'];
  return typeof event === 'string' && event !== '' ? event : undefined;
}

/** Where one run of text sat inside an output, so a replacement goes back in the same place. */
export type TextPath = readonly (string | number)[];

export interface OutputText {
  readonly text: string;
  /** Every place text sat that a replacement may be written into. */
  readonly fields: readonly TextPath[];
  /**
   * Values the walk did not read, because the output was deeper or larger than
   * it will follow. Counted rather than ignored: a judgment that says a result
   * was screened has to be true of all of it.
   */
  readonly unreadable: number;
}

/** How deep an output is followed before the rest is counted as unread. */
const MAX_DEPTH = 12;
/** How many values are visited before the rest is counted as unread. */
const MAX_NODES = 20_000;

/**
 * A value that names a shape rather than carrying content.
 *
 * This is keyed off the value, not off the key, and that is the whole point. A
 * tool's output carries closed value sets: the subagent tool reports
 * `status: "completed" | "async_launched"`, a content block is
 * `type: "text" | "image" | "resource"`, a todo is `status: "in_progress"`.
 * Writing an empty string over one of those produces a value the tool's schema
 * does not admit, and a replacement the schema does not admit is discarded in
 * silence while the original reaches the model. Keying off a list of key names
 * missed every enum whose key was not on the list.
 *
 * Markers are therefore left exactly as they came, and they are not screened
 * either: a lowercase token this short carries no instruction worth reading, and
 * folding it into the screened text charges for a block that says nothing and
 * corrupts the text an annotation rebuilds.
 *
 * Everything else is content. A free-form string field set to an empty string is
 * still a string, so emptying a path or a URL keeps the value admissible where
 * emptying an enum does not.
 */
const MARKER_MAX = 24;
const MARKER = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
const MIME = /^[a-z]{1,16}\/[a-z0-9][a-z0-9.+-]{0,62}$/;

function looksLikeMarker(value: string): boolean {
  return (value.length <= MARKER_MAX && MARKER.test(value)) || MIME.test(value);
}

/**
 * A field a tool puts its body in is never a marker, whatever it happens to
 * hold. `stdout` of a command that printed one lowercase word is content that
 * came back short, not a name for the shape, and skipping it would leave a
 * result unscreened and unrecorded.
 */
function isMarker(key: string | number | undefined, value: string): boolean {
  return typeof key === 'string' && BODY_KEYS.has(key) ? false : looksLikeMarker(value);
}

/**
 * Field names a tool puts its main body in.
 *
 * The notice goes here when one is present, ahead of whatever run of text
 * happens to be longest. A shell result that edited a file carries the diff
 * alongside an empty `stdout`, and a content block list carries a base64 image
 * beside the prose: in both, the longest run is not the one the reader reads.
 */
const BODY_KEYS = new Set(['stdout', 'text', 'content', 'result', 'output', 'stderr', 'message']);

/** Long, unbroken and base64-shaped: an encoded blob rather than anything a reader reads. */
const BLOB = /^[A-Za-z0-9+/=_-]{256,}$/;

interface Walk {
  readonly parts: string[];
  readonly fields: TextPath[];
  unreadable: number;
  nodes: number;
}

/**
 * Every string an output carries, wherever it sits.
 *
 * The shape depends on the tool, and the ones that matter are not flat: a `Read`
 * result puts the file under `file.content`, and an MCP tool returns a bare
 * array of content blocks. Reading only the top level screened the discriminator
 * and called the result screened, which is the failure this walk exists to stop.
 */
function visit(value: unknown, path: TextPath, depth: number, state: Walk): void {
  // A number, a boolean or a null holds no text and costs nothing to pass over,
  // so it neither spends the budget nor counts as something left unread.
  // Spending the budget on them made padding a result with a few thousand of
  // them enough to exhaust it before the walk reached the body, which then went
  // unscreened, and made an ordinary result full of numbers report thousands of
  // unread parts and get withheld for it.
  if (typeof value !== 'string' && !Array.isArray(value) && !isRecord(value)) {
    return;
  }
  if (state.nodes >= MAX_NODES || depth > MAX_DEPTH) {
    state.unreadable += 1;
    return;
  }
  state.nodes += 1;

  if (typeof value === 'string') {
    const key = path[path.length - 1];
    // An empty body field is still where the notice belongs. A shell command
    // that only edited a file returns an empty `stdout` beside a long diff, and
    // the reader still reads stdout.
    if (value === '') {
      if (typeof key === 'string' && BODY_KEYS.has(key)) {
        state.fields.push(path);
      }
      return;
    }
    // A marker is neither read nor written: it names the shape, it carries no
    // instruction, and overwriting it is what gets a whole replacement thrown
    // away in favour of the original.
    if (isMarker(key, value)) {
      return;
    }
    state.parts.push(value);
    state.fields.push(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      visit(item, [...path, index], depth + 1, state);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      visit(item, [...path, key], depth + 1, state);
    }
  }
}

/** Every string a tool's output carries, in the order the output lists them. */
export function outputText(response: unknown): OutputText {
  const state: Walk = { parts: [], fields: [], unreadable: 0, nodes: 0 };
  visit(response, [], 0, state);
  return { text: state.parts.join('\n\n'), fields: state.fields, unreadable: state.unreadable };
}

/**
 * How much readable text a replacement left behind.
 *
 * A quarantine tells the model it is not being shown any of the result, and that
 * sentence has to be true. The replacement cannot make it true on its own: the
 * first walk stops at a budget, and whatever sat past that point is still in the
 * value that goes back. So the built replacement is walked again, further than
 * the first walk goes, and anything that is neither a marker nor the notice is
 * text this failed to withhold.
 *
 * The answer drives what the model is told, rather than being swallowed. Saying
 * nothing was shown while some of it was is the failure this whole path exists
 * to prevent.
 */
const CHECK_DEPTH = 64;
const CHECK_NODES = 200_000;

function surviving(
  value: unknown,
  notice: string,
  key: string | number | undefined,
  depth: number,
  state: { count: number; nodes: number },
): void {
  if (typeof value !== 'string' && !Array.isArray(value) && !isRecord(value)) {
    return;
  }
  if (state.nodes >= CHECK_NODES || depth > CHECK_DEPTH) {
    // Could not be checked, so it is counted as survived rather than as absent.
    state.count += 1;
    return;
  }
  state.nodes += 1;
  if (typeof value === 'string') {
    if (value !== '' && value !== notice && !isMarker(key, value)) {
      state.count += 1;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [at, item] of value.entries()) {
      surviving(item, notice, at, depth + 1, state);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [name, item] of Object.entries(value)) {
      surviving(item, notice, name, depth + 1, state);
    }
  }
}

export function survivingText(replaced: unknown, notice: string): number {
  const state = { count: 0, nodes: 0 };
  surviving(replaced, notice, undefined, 0, state);
  return state.count;
}

function setAt(root: unknown, path: TextPath, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    if (typeof head !== 'number') {
      return root;
    }
    const copy = [...root];
    copy[head] = setAt(root[head], rest, value);
    return copy;
  }
  if (isRecord(root)) {
    if (typeof head !== 'string') {
      return root;
    }
    // A computed key defines an own property rather than reaching the prototype
    // setter, so a `__proto__` field in a tool's output stays a field.
    return { ...root, [head]: setAt(root[head], rest, value) };
  }
  return root;
}

/**
 * The same output with its text replaced, in the shape it arrived in.
 *
 * The notice goes in the longest run of text, which is where the payload was,
 * and the other text is emptied. Everything that described the shape rather than
 * carrying text is passed through untouched: that is what keeps the value
 * matching the tool's schema, and a value that does not match is discarded in
 * favour of the original.
 */
function carrierOf(response: unknown, fields: readonly TextPath[]): TextPath | undefined {
  if (fields.length === 0) {
    return undefined;
  }
  const valueAt = (path: TextPath): string => {
    const found = readAt(response, path);
    return typeof found === 'string' ? found : '';
  };
  const rank = (path: TextPath): number => {
    const key = path[path.length - 1];
    return typeof key === 'string' && BODY_KEYS.has(key) ? 2 : BLOB.test(valueAt(path)) ? 0 : 1;
  };
  let carrier = fields[0] as TextPath;
  for (const field of fields) {
    const better =
      rank(field) > rank(carrier) ||
      (rank(field) === rank(carrier) && valueAt(field).length > valueAt(carrier).length);
    if (better) {
      carrier = field;
    }
  }
  return carrier;
}

export function replaceOutput(response: unknown, text: string): unknown {
  const { fields } = outputText(response);
  const carrier = carrierOf(response, fields);
  if (carrier === undefined) {
    // Nothing to put it in without inventing a shape, and an invented shape is
    // one the client throws away.
    return undefined;
  }
  let out: unknown = response;
  for (const field of fields) {
    out = setAt(out, field, field === carrier ? text : '');
  }
  return out;
}

/**
 * The same output with a banner added, and nothing taken away.
 *
 * Annotating is not withholding, and reusing the withholding path for it did
 * real damage: every other run of text was emptied, and the body the model read
 * was rebuilt from the screened blocks rather than being the body that arrived.
 * On a file read that rebuilt body spliced the file's path into the contents and
 * pointed the flagged-section markers at it, so the model was shown a file that
 * differed from the file and a marker around the wrong text.
 *
 * So the result is returned as it came, with the banner in front of the run of
 * text the reader reads. The flagged text is fenced only when it is actually
 * found there, because a marker around nothing names nothing.
 */
export function annotateOutput(
  response: unknown,
  banner: (fenced: boolean) => string,
  flagged?: string,
): unknown {
  const { fields } = outputText(response);
  const carrier = carrierOf(response, fields);
  if (carrier === undefined) {
    return undefined;
  }
  const body = readAt(response, carrier);
  if (typeof body !== 'string') {
    return undefined;
  }
  const fence =
    flagged !== undefined && flagged !== '' && body.includes(flagged) ? flagged : undefined;
  const marked = fence === undefined ? body : body.replace(fence, fencedSection(fence));
  return setAt(response, carrier, `${banner(fence !== undefined)}\n\n${marked}`);
}

function fencedSection(text: string): string {
  return `[agent-chaperone: start of flagged section]\n${text}\n[agent-chaperone: end of flagged section]`;
}

function readAt(root: unknown, path: TextPath): unknown {
  let at: unknown = root;
  for (const key of path) {
    if (Array.isArray(at) && typeof key === 'number') {
      at = at[key];
    } else if (isRecord(at) && typeof key === 'string') {
      at = at[key];
    } else {
      return undefined;
    }
  }
  return at;
}

export interface PreResponse {
  readonly decision?: 'deny' | 'ask';
  readonly reason?: string;
  /** Shown to the user rather than to the model. */
  readonly warning?: string;
}

/** What a client reads back from a pre-tool hook. */
export function preResponse(response: PreResponse): string {
  const warning = response.warning === undefined ? {} : { systemMessage: response.warning };
  if (response.decision === undefined) {
    // No decision. The call carries on through the user's own permission rules,
    // which is not the same as approving it.
    return response.warning === undefined ? '' : JSON.stringify(warning);
  }
  return JSON.stringify({
    ...warning,
    hookSpecificOutput: {
      hookEventName: PRE_TOOL_USE,
      permissionDecision: response.decision,
      permissionDecisionReason: response.reason ?? '',
    },
  });
}

export interface PostResponse {
  /** Replaces what the model reads. Left out when the shape could not be matched. */
  readonly output?: unknown;
  /** Added alongside the output, which works whatever the shape. */
  readonly context?: string;
  /** Shown to the user rather than to the model. */
  readonly warning?: string;
  /** Which event is being answered, because a failed tool's output cannot be replaced. */
  readonly event?: string;
}

/** What a client reads back from a post-tool hook. */
export function postResponse(response: PostResponse): string {
  const failure = response.event === POST_TOOL_USE_FAILURE;
  // A failed tool's event accepts context and nothing else. Sending a
  // replacement there would be discarded in silence, which is worse than not
  // sending one, so the caller is told by getting nothing back to send.
  const output = failure ? undefined : response.output;
  const warning = response.warning === undefined ? {} : { systemMessage: response.warning };
  if (output === undefined && response.context === undefined) {
    return response.warning === undefined ? '' : JSON.stringify(warning);
  }
  return JSON.stringify({
    ...warning,
    hookSpecificOutput: {
      hookEventName: failure ? POST_TOOL_USE_FAILURE : POST_TOOL_USE,
      ...(output === undefined ? {} : { updatedToolOutput: output }),
      ...(response.context === undefined ? {} : { additionalContext: response.context }),
    },
  });
}
