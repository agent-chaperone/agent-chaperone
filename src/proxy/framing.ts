/**
 * Newline-delimited framing for a JSON-RPC stream.
 *
 * The MCP SDK ships its own stdio framing, but it validates every message
 * against a strict schema and rejects a request carrying an unknown top-level
 * field. A proxy that refuses those messages is not transparent, so the framing
 * here does no validation at all and hands the caller the exact line it read.
 */

/** Matches the MCP SDK's own default, so the proxy is never the first to refuse a large message. */
export const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;

export class LineTooLongError extends Error {
  constructor(readonly maxLineBytes: number) {
    super(`A message exceeded the ${maxLineBytes} byte limit before a newline arrived`);
    this.name = 'LineTooLongError';
  }
}

/**
 * Accumulates stream chunks and yields complete lines.
 *
 * Every byte is examined exactly once, on arrival, and buffered pieces are
 * joined only when a newline actually completes a line. Holding one growing
 * buffer instead would re-copy the whole pending line on every chunk, which
 * makes a peer that dribbles bytes without a newline quadratic in the length of
 * the line it is building, and that peer is untrusted.
 */
export class LineBuffer {
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #ready: string[] = [];
  #overflowed = false;

  constructor(private readonly maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {}

  append(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const index = chunk.indexOf(0x0a, start);
      if (index === -1) {
        break;
      }
      this.#pending.push(chunk.subarray(start, index));
      this.#pendingBytes += index - start;
      if (this.#pendingBytes > this.maxLineBytes) {
        // The line is complete but too large to be a message anyone should
        // relay. Refuse it rather than passing it on.
        this.#reset();
        this.#overflowed = true;
      } else {
        const line = Buffer.concat(this.#pending).toString('utf8').replace(/\r$/, '');
        this.#reset();
        if (line.length > 0) {
          this.#ready.push(line);
        }
      }
      start = index + 1;
    }

    const tail = chunk.subarray(start);
    if (tail.length > 0) {
      this.#pending.push(tail);
      this.#pendingBytes += tail.length;
    }

    // Release the memory at the moment the limit is passed rather than at the
    // next drain, so a peer cannot keep growing a line it will never finish.
    if (this.#pendingBytes > this.maxLineBytes) {
      this.#reset();
      this.#overflowed = true;
    }
  }

  #reset(): void {
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  /**
   * Take every complete line seen so far.
   *
   * @throws {LineTooLongError} when a line passed the size limit since the last drain.
   */
  drain(): string[] {
    if (this.#overflowed) {
      this.#overflowed = false;
      this.#ready = [];
      throw new LineTooLongError(this.maxLineBytes);
    }
    const lines = this.#ready;
    this.#ready = [];
    return lines;
  }

  /** Bytes held for an incomplete line. Exposed for tests and diagnostics. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }
}

/** Frame a line for the wire. The proxy relays `envelope.raw` through this and nothing else. */
export function frame(line: string): string {
  return `${line}\n`;
}
