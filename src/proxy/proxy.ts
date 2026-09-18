/**
 * The relay.
 *
 * Every line that arrives on one side is written to the other side exactly as
 * it arrived. Parsing happens on a copy, only to correlate responses with
 * requests and to hand each message to `onEvent`, which is the seam the screens
 * attach to later. Nothing here inspects content or blocks anything.
 */

import type { Readable, Writable } from 'node:stream';
import { LineBuffer, frame } from './framing.js';
import { inspect, type Envelope } from './jsonrpc.js';
import { RequestCorrelator, type CorrelatorOptions, type PendingRequest } from './correlator.js';

export type Direction = 'client-to-upstream' | 'upstream-to-client';

export type ProxyEvent =
  | {
      readonly type: 'message';
      readonly direction: Direction;
      readonly envelope: Envelope;
      /** For a response travelling back, the request it answers, when still known. */
      readonly request?: PendingRequest;
      /** False when the far side was already gone, so the line never left. */
      readonly delivered: boolean;
    }
  | { readonly type: 'stream-error'; readonly direction: Direction; readonly error: Error };

export interface ProxyStreams {
  readonly clientInput: Readable;
  readonly clientOutput: Writable;
  readonly upstreamInput: Writable;
  readonly upstreamOutput: Readable;
}

export interface ProxyOptions extends CorrelatorOptions {
  readonly maxLineBytes?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: ProxyEvent) => void;
}

export interface ProxyHandle {
  /** Resolves once both directions have finished. */
  readonly closed: Promise<void>;
  close(): void;
}

/**
 * A peer closing its end of a pipe is ordinary, not a failure of this program.
 * Those errors end the direction quietly; anything else is a real stream fault
 * and is reported on the event seam.
 */
const PEER_GONE = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ECONNRESET',
]);

function isPeerGone(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && PEER_GONE.has(code);
}

export function createProxy(streams: ProxyStreams, options: ProxyOptions = {}): ProxyHandle {
  const now = options.now ?? Date.now;
  const emit = options.onEvent ?? (() => undefined);
  const correlator = new RequestCorrelator(options);

  let openDirections = 2;
  let settle: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const finish = (): void => {
    openDirections -= 1;
    if (openDirections <= 0) {
      settle();
    }
  };

  const sources: Readable[] = [];
  const teardown = (): void => {
    for (const source of sources) {
      if (!source.destroyed) {
        source.destroy();
      }
    }
  };

  /**
   * `endsSession` marks the direction whose end means there is nothing left to
   * proxy. When the client disconnects we only close the upstream's input and
   * let the server flush its last replies and exit on its own. When the server
   * goes, nothing more can arrive, so the whole session comes down.
   */
  const relay = (
    direction: Direction,
    source: Readable,
    sink: Writable,
    endsSession: boolean,
  ): void => {
    const buffer = new LineBuffer(options.maxLineBytes);
    let done = false;
    let paused = false;
    let reported = false;
    sources.push(source);

    const stop = (): void => {
      if (done) {
        return;
      }
      done = true;
      endWritable(sink);
      finish();
      if (endsSession) {
        teardown();
      }
    };

    // A framing failure ends the session rather than one half of it. Half a
    // proxy still relaying is worse than none: the peers would carry on
    // believing they are still being watched.
    const fail = (error: Error): void => {
      if (!reported) {
        reported = true;
        emit({ type: 'stream-error', direction, error });
      }
      stop();
      teardown();
    };

    // Honour backpressure. A large tool result relayed to a slow reader would
    // otherwise queue in memory without limit, which is the same failure the
    // line cap exists to prevent, arriving from the other side.
    const push = (text: string): boolean => {
      if (!sink.writable) {
        return false;
      }
      try {
        if (!sink.write(text) && !paused) {
          paused = true;
          source.pause();
          sink.once('drain', () => {
            paused = false;
            source.resume();
          });
        }
        return true;
      } catch {
        return false;
      }
    };

    // Without this, a peer that closes its end mid-write turns an ordinary
    // EPIPE into an unhandled error event, and the proxy dies with a stack
    // trace instead of passing the upstream's own exit code along.
    sink.on('error', (error: Error) => {
      if (isPeerGone(error)) {
        stop();
      } else {
        fail(error);
      }
    });

    source.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        buffer.append(chunk);
        lines = buffer.drain();
      } catch (error) {
        fail(asError(error));
        return;
      }
      for (const line of lines) {
        const envelope = inspect(line);
        // Write first, then report what actually happened. Announcing a
        // delivery the relay did not perform would put a message in the audit
        // log that no peer ever saw.
        const delivered = push(frame(envelope.raw));
        let request: PendingRequest | undefined;
        if (direction === 'client-to-upstream') {
          if (delivered) {
            correlator.record(envelope, now());
          }
        } else {
          request = correlator.take(envelope);
        }
        emit({ type: 'message', direction, envelope, request, delivered });
      }
    });

    source.on('error', (error: Error) => {
      if (isPeerGone(error)) {
        stop();
      } else {
        fail(error);
      }
    });
    source.on('end', () => stop());
    source.on('close', () => stop());
  };

  relay('client-to-upstream', streams.clientInput, streams.upstreamInput, false);
  relay('upstream-to-client', streams.upstreamOutput, streams.clientOutput, true);

  return {
    closed,
    close(): void {
      teardown();
    },
  };
}

function endWritable(sink: Writable): void {
  if (sink.writable && !sink.writableEnded) {
    try {
      sink.end();
    } catch {
      // The far side is already gone. Nothing left to close.
    }
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
