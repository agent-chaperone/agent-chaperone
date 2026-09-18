/**
 * Pairs a JSON-RPC response with the request that produced it.
 *
 * A later screen needs the arguments of a `tools/call` when it judges the
 * result that came back, and the two arrive as separate messages. This keeps
 * the link. It is pure: no clock, no I/O, time is passed in.
 */

import type { Envelope, JsonRpcId } from './jsonrpc.js';

export interface PendingRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly envelope: Envelope;
  readonly receivedAt: number;
}

/** Guards against a peer that opens requests and never reads the answers. */
export const DEFAULT_MAX_PENDING = 1024;

/**
 * Bounds what those pending requests may hold. A count alone does not bound
 * memory, because a single entry keeps the whole raw line, and a line may be
 * as large as the framing limit allows.
 */
export const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;

export interface CorrelatorOptions {
  readonly maxPending?: number;
  readonly maxPendingBytes?: number;
}

export class RequestCorrelator {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #bytes = new Map<string, number>();
  readonly #maxPending: number;
  readonly #maxPendingBytes: number;
  #totalBytes = 0;

  constructor(options: CorrelatorOptions | number = {}) {
    const resolved = typeof options === 'number' ? { maxPending: options } : options;
    this.#maxPending = resolved.maxPending ?? DEFAULT_MAX_PENDING;
    this.#maxPendingBytes = resolved.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  }

  /**
   * Remember a request. Ids are namespaced by type, so the number 1 and the
   * string "1" are different requests, as JSON-RPC intends.
   */
  record(envelope: Envelope, receivedAt: number): void {
    if (envelope.kind !== 'request' || envelope.id === undefined || envelope.method === undefined) {
      return;
    }
    const id = key(envelope.id);
    if (id === undefined) {
      return;
    }
    const size = Buffer.byteLength(envelope.raw, 'utf8');
    this.#evictUntilRoom(size);
    this.#drop(id);
    this.#pending.set(id, { id: envelope.id, method: envelope.method, envelope, receivedAt });
    this.#bytes.set(id, size);
    this.#totalBytes += size;
  }

  /** Take the request this response answers, if it is still known. */
  take(envelope: Envelope): PendingRequest | undefined {
    if (envelope.kind !== 'response' || envelope.id === undefined) {
      return undefined;
    }
    const id = key(envelope.id);
    if (id === undefined) {
      return undefined;
    }
    const match = this.#pending.get(id);
    this.#drop(id);
    return match;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Bytes currently held by pending requests. Exposed for tests and diagnostics. */
  get byteSize(): number {
    return this.#totalBytes;
  }

  #evictUntilRoom(incoming: number): void {
    while (
      this.#pending.size > 0 &&
      (this.#pending.size >= this.#maxPending ||
        this.#totalBytes + incoming > this.#maxPendingBytes)
    ) {
      const oldest = this.#pending.keys().next();
      if (oldest.done) {
        return;
      }
      this.#drop(oldest.value);
    }
  }

  #drop(id: string): void {
    if (!this.#pending.delete(id)) {
      return;
    }
    this.#totalBytes -= this.#bytes.get(id) ?? 0;
    this.#bytes.delete(id);
  }
}

/**
 * A stable key for an id, or undefined when the id cannot be correlated safely.
 *
 * JSON numbers larger than a double can represent collapse onto the same value,
 * so two distinct ids on the wire would share a key and a peer could make the
 * proxy hand back a response paired with a different request's arguments.
 * Those ids still relay untouched; they are simply not paired.
 */
function key(id: JsonRpcId): string | undefined {
  if (typeof id === 'string') {
    return `s:${id}`;
  }
  return Number.isSafeInteger(id) ? `n:${id}` : undefined;
}
