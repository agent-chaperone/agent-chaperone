/**
 * Tolerant JSON-RPC inspection.
 *
 * The proxy never rewrites a message. It parses a copy of each line only far
 * enough to correlate a response with the request that produced it, and keeps
 * the original text for relaying. Anything it cannot classify is still passed
 * through untouched, because a transparent proxy that drops what it does not
 * recognise is worse than no proxy at all.
 */

export type JsonRpcId = string | number;

export type EnvelopeKind = 'request' | 'notification' | 'response' | 'other' | 'unparseable';

export interface Envelope {
  /** The exact line as it arrived, without its trailing newline. This is what gets relayed. */
  readonly raw: string;
  readonly kind: EnvelopeKind;
  readonly id?: JsonRpcId;
  readonly method?: string;
  /** The parsed value, present whenever the line was valid JSON. */
  readonly value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: Record<string, unknown>): JsonRpcId | undefined {
  const id = value['id'];
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/**
 * Classify one line. Never throws: a line that is not JSON comes back as
 * `unparseable` so the caller can relay it and carry on.
 */
export function inspect(line: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { raw: line, kind: 'unparseable' };
  }

  if (!isRecord(value)) {
    // Arrays are JSON-RPC batches, which MCP does not use. Relay, do not correlate.
    return { raw: line, kind: 'other', value };
  }

  const id = readId(value);
  const method = typeof value['method'] === 'string' ? value['method'] : undefined;
  const isResult = Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error');

  if (method !== undefined) {
    return id === undefined
      ? { raw: line, kind: 'notification', method, value }
      : { raw: line, kind: 'request', id, method, value };
  }
  if (id !== undefined && isResult) {
    return { raw: line, kind: 'response', id, value };
  }
  return { raw: line, kind: 'other', value };
}
