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

/**
 * What the relay should do with one message.
 *
 * `answer` is the one that needs explaining: it withholds the message and
 * replies to the peer that sent it. A held tool call is not forwarded and the
 * client still has to be told something, or it waits forever on a request the
 * server never received.
 */
export type GateVerdict =
  | { readonly kind: 'forward' }
  | { readonly kind: 'replace'; readonly raw: string }
  | { readonly kind: 'drop' }
  | { readonly kind: 'answer'; readonly raw: string };

/**
 * Decides what happens to a message before it is relayed.
 *
 * Returning a verdict rather than a promise is the fast path and is what the
 * vast majority of traffic takes: the message is written in the same turn it
 * arrived, exactly as before there was a gate at all. Only a message the gate
 * actually wants to think about pays for the wait.
 */
export type Gate = (
  envelope: Envelope,
  direction: Direction,
  request: PendingRequest | undefined,
) => GateVerdict | Promise<GateVerdict>;

const FORWARD: GateVerdict = { kind: 'forward' };

function isPromise(value: unknown): value is Promise<GateVerdict> {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function';
}

export type ProxyEvent =
  | {
      readonly type: 'message';
      readonly direction: Direction;
      /** What the gate decided. Always `forward` when no gate is configured. */
      readonly verdict: GateVerdict['kind'];
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
  /** Without one, every message is forwarded and nothing waits. */
  readonly gate?: Gate;
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
  const gate = options.gate ?? ((): GateVerdict => FORWARD);
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
    answerSink: Writable,
    endsSession: boolean,
  ): void => {
    const buffer = new LineBuffer(options.maxLineBytes);
    let done = false;
    let writePaused = false;
    let answerPaused = false;
    let gatePaused = false;
    let reported = false;
    let pending = 0;
    let chain: Promise<void> | undefined;
    let sourceEnded = false;
    sources.push(source);

    // Two independent reasons to stop reading, and Node's pause does not count
    // how many times it was asked, so both are tracked and the source only runs
    // again when neither holds.
    const syncFlow = (): void => {
      if (writePaused || answerPaused || gatePaused) {
        source.pause();
      } else {
        source.resume();
      }
    };

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
        if (!sink.write(text) && !writePaused) {
          writePaused = true;
          syncFlow();
          sink.once('drain', () => {
            writePaused = false;
            syncFlow();
          });
        }
        return true;
      } catch {
        return false;
      }
    };

    /**
     * Reply to the peer that sent the message, for a call the gate withheld.
     *
     * Backpressure is honoured here as it is on the forward path. A peer that
     * writes calls faster than it reads the refusals would otherwise have them
     * queue in memory without limit, which is the same failure the line cap
     * exists to prevent, arriving by a different door.
     */
    const answer = (text: string): boolean => {
      if (!answerSink.writable) {
        return false;
      }
      try {
        if (!answerSink.write(text) && !answerPaused) {
          answerPaused = true;
          syncFlow();
          answerSink.once('drain', () => {
            answerPaused = false;
            syncFlow();
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

    /**
     * Carry out one verdict.
     *
     * Write first, then report what actually happened. Announcing a delivery
     * the relay did not perform would put a message in the audit log that no
     * peer ever saw.
     */
    const apply = (
      envelope: Envelope,
      verdict: GateVerdict,
      request: PendingRequest | undefined,
    ): void => {
      let delivered = false;
      if (verdict.kind === 'forward') {
        delivered = push(frame(envelope.raw));
      } else if (verdict.kind === 'replace') {
        delivered = push(frame(verdict.raw));
      } else if (verdict.kind === 'answer') {
        delivered = answer(frame(verdict.raw));
      }

      // A request the upstream never received must not be left waiting for a
      // reply, and one it did receive has to be there when the reply arrives.
      if (direction === 'client-to-upstream' && delivered && verdict.kind !== 'answer') {
        correlator.record(envelope, now());
      }
      emit({ type: 'message', direction, envelope, request, delivered, verdict: verdict.kind });
    };

    /**
     * Queue work behind whatever is already waiting, so messages leave in the
     * order they arrived. Reading stops while anything is in flight: a gate that
     * takes a second to answer would otherwise let the rest of the session pile
     * up in memory behind it.
     */
    const enqueue = (run: () => Promise<void>): void => {
      pending += 1;
      if (!gatePaused) {
        gatePaused = true;
        syncFlow();
      }
      const settle = (): void => {
        pending -= 1;
        if (pending === 0) {
          chain = undefined;
          gatePaused = false;
          syncFlow();
          if (sourceEnded) {
            stop();
          }
        }
      };
      chain = (chain ?? Promise.resolve()).then(run, run).then(settle, settle);
    };

    const handle = (line: string): void => {
      const envelope = inspect(line);
      // Taken before the gate runs, because screening a result needs the call
      // that produced it, and because a message the gate withholds still
      // resolves the request it belongs to.
      const request = direction === 'upstream-to-client' ? correlator.take(envelope) : undefined;

      let verdict: GateVerdict | Promise<GateVerdict>;
      try {
        verdict = gate(envelope, direction, request);
      } catch (error) {
        emit({ type: 'stream-error', direction, error: asError(error) });
        verdict = FORWARD;
      }

      if (pending === 0 && !isPromise(verdict)) {
        apply(envelope, verdict, request);
        return;
      }
      const decided = verdict;
      // Claimed now rather than when the queue reaches it. A rejection sitting
      // unhandled for a turn is one Node reports as fatal, and the message it
      // belongs to may be several decisions back in the queue.
      if (isPromise(decided)) {
        decided.catch(() => undefined);
      }
      enqueue(async () => {
        try {
          apply(envelope, await decided, request);
        } catch (error) {
          // A gate that throws is a bug in screening, not a reason to drop a
          // message the peers are waiting on.
          emit({ type: 'stream-error', direction, error: asError(error) });
          apply(envelope, FORWARD, request);
        }
      });
    };

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
        handle(line);
      }
    });

    source.on('error', (error: Error) => {
      if (isPeerGone(error)) {
        stop();
      } else {
        fail(error);
      }
    });
    // Anything still with the gate has to land before the direction closes, or a
    // screened message would be dropped by the source ending underneath it.
    const endWhenDrained = (): void => {
      sourceEnded = true;
      if (pending === 0) {
        stop();
      }
    };
    source.on('end', endWhenDrained);
    source.on('close', endWhenDrained);
  };

  relay(
    'client-to-upstream',
    streams.clientInput,
    streams.upstreamInput,
    streams.clientOutput,
    false,
  );
  relay(
    'upstream-to-client',
    streams.upstreamOutput,
    streams.clientOutput,
    streams.upstreamInput,
    true,
  );

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
