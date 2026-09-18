/**
 * Reading and writing the few MCP shapes screening actually touches.
 *
 * The rule that governs this file: whatever an agent can read, the screen has to
 * read too. A result whose text sits somewhere this file does not look is a
 * result that reaches the agent unscreened, which is the whole of what the tool
 * is for. So text is collected from every place the protocol puts it, and
 * anything that cannot be read as text is counted rather than ignored, because
 * the gate has to know the screen did not see all of it.
 *
 * A replacement is rebuilt from the parsed message rather than edited as text,
 * so the id, the protocol version and fields this package has never heard of
 * survive. `structuredContent` is the exception: it is the machine-readable twin
 * of the content, clients hand it to the model in preference to the text, and
 * carrying it through a replacement would deliver the payload alongside the
 * notice saying the payload was withheld.
 */

import type { Envelope, JsonRpcId } from '../proxy/index.js';

export const TOOL_CALL = 'tools/call';
export const RESOURCE_READ = 'resources/read';

export interface ToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

/** Where a result's text came from, so a replacement goes back in the same shape. */
export type ResultShape = 'tool' | 'resource' | 'error';

export interface ResultText {
  readonly text: string;
  readonly shape: ResultShape;
  /**
   * Parts the screen could not read, such as an image or a base64 blob. Counted
   * rather than dropped: a judgment that says a result was screened has to be
   * true of all of it.
   */
  readonly unreadable: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The call a `tools/call` request is making, or undefined when it is not one. */
export function readToolCall(envelope: Envelope): ToolCall | undefined {
  if (envelope.kind !== 'request' || envelope.method !== TOOL_CALL) {
    return undefined;
  }
  const params = isRecord(envelope.value) ? envelope.value['params'] : undefined;
  if (!isRecord(params) || typeof params['name'] !== 'string') {
    return undefined;
  }
  return { name: params['name'], arguments: params['arguments'] };
}

function stringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Every string a content part carries.
 *
 * The union is wider than it looks: text sits at `text` on a text part, at
 * `resource.text` on an embedded resource, and at `description` on a resource
 * link. A server choosing the shape its payload travels in is not a reason for
 * the payload to go unread.
 */
function fromParts(parts: unknown, out: string[]): number {
  if (!Array.isArray(parts)) {
    return 0;
  }
  let unreadable = 0;
  for (const part of parts) {
    if (!isRecord(part)) {
      unreadable += 1;
      continue;
    }
    let found = false;
    for (const key of ['text', 'description', 'name', 'uri'] as const) {
      if (typeof part[key] === 'string' && part[key] !== '') {
        out.push(part[key]);
        found = true;
      }
    }
    const resource = part['resource'];
    if (isRecord(resource)) {
      for (const key of ['text', 'uri'] as const) {
        if (typeof resource[key] === 'string' && resource[key] !== '') {
          out.push(resource[key]);
          found = true;
        }
      }
      if (typeof resource['blob'] === 'string') {
        unreadable += 1;
      }
    }
    if (typeof part['blob'] === 'string') {
      unreadable += 1;
    }
    if (!found) {
      unreadable += 1;
    }
  }
  return unreadable;
}

/**
 * The text an agent would read out of a result.
 *
 * Parts are joined the way they are shown, so a marker split across two of them
 * is still one run of text to the rules that look for it.
 */
export function readResultText(envelope: Envelope, method: string): ResultText | undefined {
  if (envelope.kind !== 'response' || !isRecord(envelope.value)) {
    return undefined;
  }

  const error = envelope.value['error'];
  if (isRecord(error)) {
    // A failed call is still a result the agent reads, and its message and data
    // are as attacker-controlled as anything in a successful one.
    const parts: string[] = [];
    if (typeof error['message'] === 'string') {
      parts.push(error['message']);
    }
    if (error['data'] !== undefined) {
      const data = stringify(error['data']);
      if (data !== undefined) {
        parts.push(data);
      }
    }
    return parts.length === 0
      ? undefined
      : { text: parts.join('\n\n'), shape: 'error', unreadable: 0 };
  }

  const result = envelope.value['result'];
  if (!isRecord(result)) {
    return undefined;
  }

  const parts: string[] = [];
  let unreadable = 0;
  if (method === TOOL_CALL) {
    unreadable = fromParts(result['content'], parts);
    if (result['structuredContent'] !== undefined) {
      const structured = stringify(result['structuredContent']);
      if (structured === undefined) {
        unreadable += 1;
      } else {
        parts.push(structured);
      }
    }
  } else if (method === RESOURCE_READ) {
    unreadable = fromParts(result['contents'], parts);
  } else {
    return undefined;
  }

  return parts.length === 0 && unreadable === 0
    ? undefined
    : { text: parts.join('\n\n'), shape: method === TOOL_CALL ? 'tool' : 'resource', unreadable };
}

/** A tool result carrying one piece of text, as an error the agent is meant to read. */
export function toolError(id: JsonRpcId, text: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError: true },
  });
}

/**
 * The same response with everything the agent would read replaced.
 *
 * Fields this package does not know about are kept, because a screening proxy
 * that quietly strips one is changing the protocol rather than watching it. The
 * payload twins are not: `structuredContent`, and any part that was not the text
 * being replaced, go, or the agent receives the notice and the thing the notice
 * says was withheld.
 */
export function withText(envelope: Envelope, shape: ResultShape, text: string): string | undefined {
  if (!isRecord(envelope.value)) {
    return undefined;
  }

  if (shape === 'error') {
    const error = envelope.value['error'];
    if (!isRecord(error)) {
      return undefined;
    }
    const { data: _dropped, ...rest } = error;
    return JSON.stringify({ ...envelope.value, error: { ...rest, message: text } });
  }

  const result = envelope.value['result'];
  if (!isRecord(result)) {
    return undefined;
  }
  const { structuredContent: _twin, ...keep } = result;

  if (shape === 'tool') {
    return JSON.stringify({
      ...envelope.value,
      result: { ...keep, content: [{ type: 'text', text }] },
    });
  }

  const contents = Array.isArray(keep['contents']) ? keep['contents'] : [];
  const first = contents.find((part) => isRecord(part) && typeof part['uri'] === 'string');
  const uri = isRecord(first) && typeof first['uri'] === 'string' ? first['uri'] : '';
  return JSON.stringify({
    ...envelope.value,
    result: { ...keep, contents: [{ uri, mimeType: 'text/plain', text }] },
  });
}
