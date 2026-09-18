/**
 * A stable identity for one request.
 *
 * Recorded answers are keyed by this, so it decides which fixture a test gets
 * and whether a question that was reworded quietly keeps the old answer. Two
 * requests that differ in any way a backend would see have to hash differently,
 * and nothing a caller can put in the state may make it throw.
 *
 * The canonical form is built as text rather than as an object, because
 * assigning a `__proto__` key onto an object reaches the prototype setter and
 * the key never lands. `JSON.parse` does produce that key as an own property, so
 * a state parsed off the wire can carry one, and an object built from a hostile
 * payload would otherwise hash the same as one without it.
 */

import { createHash } from 'node:crypto';

/** Deep enough for any tool result, shallow enough not to exhaust the stack. */
const MAX_DEPTH = 64;

function canonical(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) {
    return '"[deep]"';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      // A non-finite number is what JSON would have sent as null.
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      return JSON.stringify(`${value}n`);
    case 'object':
      break;
    default:
      // undefined, a function, a symbol: none of them reach a backend.
      return 'null';
  }
  if (value === null) {
    return 'null';
  }

  const object: object = value;
  if (seen.has(object)) {
    return '"[cycle]"';
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => canonical(item, depth + 1, seen)).join(',')}]`;
    }
    const toJson = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      try {
        return canonical((toJson as () => unknown).call(object), depth + 1, seen);
      } catch {
        return '"[unserializable]"';
      }
    }
    const parts: string[] = [];
    for (const key of Object.keys(object).sort()) {
      const item = (object as Record<string, unknown>)[key];
      if (item === undefined) {
        // A property JSON would have dropped, so it is not part of the request.
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonical(item, depth + 1, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

export function requestHash(state: unknown, battery: unknown): string {
  const text = `state:${canonical(state, 0, new Set())}\nbattery:${canonical(battery, 0, new Set())}`;
  return createHash('sha256').update(text).digest('hex');
}
