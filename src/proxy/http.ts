/**
 * Connecting to a Streamable HTTP upstream MCP server.
 *
 * The relay is written against a pair of byte streams, because that is what a
 * child process gives it. An HTTP server gives messages instead, so this module
 * presents one as the other: lines written to `stdin` are parsed and sent as
 * JSON-RPC, and every message that arrives is framed back onto `stdout`. The
 * proxy, the correlator and both screens are unchanged and unaware.
 *
 * The one behaviour that cannot survive the move is byte fidelity. A stdio
 * upstream receives the client's line exactly as the client wrote it; an HTTP
 * upstream receives a re-serialisation of the same message, because the
 * transport takes an object. Screening reads the parsed form either way, so
 * what is screened and what is sent still match.
 */

import { PassThrough, Writable } from 'node:stream';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_MAX_LINE_BYTES, LineBuffer, frame } from './framing.js';
import type { Upstream } from './upstream.js';

export class UpstreamConnectError extends Error {
  constructor(url: URL, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not reach the upstream server at ${url.href}: ${detail}`);
    this.name = 'UpstreamConnectError';
  }
}

export class UpstreamProtocolError extends Error {
  constructor(detail: string) {
    super(`The upstream server at the other end of the relay ${detail}`);
    this.name = 'UpstreamProtocolError';
  }
}

/**
 * A line the client sent that cannot be forwarded over HTTP.
 *
 * A stdio upstream would have received the bytes and rejected them itself. This
 * transport takes objects, so a line that is not JSON has nowhere to go, and
 * dropping it silently would leave the client waiting on a reply to a request
 * the server never saw. The session ends instead, loudly.
 */
export class UnsendableLineError extends Error {
  constructor(detail: string) {
    super(`A line could not be forwarded to the upstream server: ${detail}`);
    this.name = 'UnsendableLineError';
  }
}

export interface HttpUpstreamOptions {
  /**
   * Extra request headers, which is where authorization goes.
   *
   * Nothing is added to this. The chaperone's own credentials reach its model
   * backend and nowhere else, the same way the stdio path withholds them from
   * the process it spawns.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxLineBytes?: number;
  /** Seam for tests. Defaults to the real transport. */
  readonly connect?: (url: URL, headers: Readonly<Record<string, string>>) => UpstreamTransport;
}

/** The part of the SDK's client transport this module actually uses. */
export interface UpstreamTransport {
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  terminateSession?(): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
}

function realTransport(url: URL, headers: Readonly<Record<string, string>>): UpstreamTransport {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { ...headers } },
  });
}

/**
 * Connect to a Streamable HTTP MCP server and present it as an `Upstream`.
 *
 * Returns synchronously, like spawning does, so a caller wires the streams the
 * same way for both. A connection that never comes up surfaces through
 * `exited`, which is where a process that fails to spawn surfaces too.
 */
export function connectHttpUpstream(url: URL, options: HttpUpstreamOptions = {}): Upstream {
  const connect = options.connect ?? realTransport;
  const transport = connect(url, options.headers ?? {});
  const stdout = new PassThrough();
  const buffer = new LineBuffer(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);

  // The relay attaches its own handler a moment later, but a transport that
  // fails between connecting and that moment would otherwise raise an unhandled
  // error on this stream and take the process down with it. A listener that does
  // nothing is enough: Node only throws when there are none, and the relay's
  // own handler still receives everything.
  stdout.on('error', () => undefined);

  let settled = false;
  let closing = false;
  let resolveExited: (code: number) => void = () => undefined;
  let rejectExited: (error: Error) => void = () => undefined;
  const exited = new Promise<number>((resolve, reject) => {
    resolveExited = resolve;
    rejectExited = reject;
  });

  /** Ends the session once, whichever of the several ways to end it happens first. */
  function settle(code: number): void {
    if (settled) {
      return;
    }
    settled = true;
    stdout.end();
    resolveExited(code);
  }

  function fail(error: Error): void {
    if (settled) {
      return;
    }
    settled = true;
    // Destroying the readable is what the relay already watches: it reports a
    // stream error on this direction, which makes the session a chaperone
    // fault rather than a clean exit. The exit code matches a process killed
    // by a signal, because from the client's side that is the same event.
    stdout.destroy(error);
    resolveExited(1);
  }

  transport.onmessage = (message: JSONRPCMessage): void => {
    if (settled) {
      return;
    }
    stdout.write(frame(JSON.stringify(message)));
  };

  transport.onerror = (error: Error): void => {
    // Once this side is shutting the session down, a transport error is the
    // expected sound of a connection being torn down and says nothing about
    // whether the traffic was screened. Reporting it would turn every ordinary
    // exit into a chaperone fault.
    if (closing) {
      return;
    }
    fail(new UpstreamProtocolError(`reported an error: ${error.message}`));
  };

  transport.onclose = (): void => {
    settle(0);
  };

  // A connection that never comes up is the HTTP equivalent of a command that
  // is not on PATH, and reaches the caller the same way: through `exited`.
  const started = transport.start().catch((error: unknown) => {
    if (!settled) {
      settled = true;
      stdout.destroy();
      rejectExited(new UpstreamConnectError(url, error));
    }
  });

  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      let lines: string[];
      try {
        buffer.append(chunk);
        lines = buffer.drain();
      } catch (error) {
        callback(error as Error);
        return;
      }
      if (lines.length === 0) {
        callback();
        return;
      }
      // Node will not call `write` again until this callback fires, so awaiting
      // each send here is what keeps messages in the order the client wrote
      // them and gives the client backpressure when the server is slow.
      void (async (): Promise<void> => {
        await started;
        for (const line of lines) {
          if (settled) {
            return;
          }
          let message: JSONRPCMessage;
          try {
            message = JSON.parse(line) as JSONRPCMessage;
          } catch {
            throw new UnsendableLineError('it is not JSON');
          }
          await transport.send(message);
        }
      })().then(
        () => callback(),
        (error: unknown) => callback(error as Error),
      );
    },
  });

  return {
    stdin,
    stdout,
    exited,
    kill(): void {
      // The spec asks a client that is done to delete its session rather than
      // leave the server holding it. A server that does not support that
      // answers 405, and a server that has already gone answers nothing at all.
      // Neither is a failure worth reporting, so both are swallowed.
      closing = true;
      const goodbye = transport.terminateSession?.().catch(() => undefined) ?? Promise.resolve();
      void goodbye.then(() => transport.close().catch(() => undefined)).then(() => settle(0));
    },
  };
}
