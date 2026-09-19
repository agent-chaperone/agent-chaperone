/**
 * A minimal Streamable HTTP MCP server, for testing the HTTP upstream against
 * something that actually speaks HTTP rather than a stand-in for one.
 *
 * It implements only what the transport exercises: a POST that carries one
 * JSON-RPC message, a JSON response for a request, 202 with no body for a
 * notification, and a session id handed out on initialize and required
 * afterwards.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMcpServer {
  readonly url: URL;
  /** Every message the server received, in arrival order. */
  readonly received: unknown[];
  /** Headers of the most recent request. */
  lastHeaders(): NodeJS.Dict<string | string[]>;
  close(): Promise<void>;
}

export interface FakeMcpServerOptions {
  /** Answer a request. Returning undefined sends a generic result. */
  readonly respond?: (message: { id?: unknown; method?: string }) => unknown;
  /** Reject every POST with this status, to exercise the failure paths. */
  readonly status?: number;
  /** Hand out a session id on initialize and require it afterwards. */
  readonly session?: string;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

export async function startFakeMcpServer(
  options: FakeMcpServerOptions = {},
): Promise<FakeMcpServer> {
  const received: unknown[] = [];
  let headers: NodeJS.Dict<string | string[]> = {};

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    headers = request.headers;

    // The transport opens a GET for server-initiated messages. Refusing it is
    // allowed by the spec and keeps this fixture to one code path.
    if (request.method === 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }

    void readBody(request).then((body) => {
      if (options.status !== undefined) {
        response.writeHead(options.status, { 'content-type': 'text/plain' }).end('refused');
        return;
      }

      let message: { id?: unknown; method?: string };
      try {
        message = JSON.parse(body) as { id?: unknown; method?: string };
      } catch {
        response.writeHead(400).end();
        return;
      }
      received.push(message);

      const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
      if (options.session !== undefined && message.method === 'initialize') {
        responseHeaders['mcp-session-id'] = options.session;
      }

      // A notification carries no id and gets no body, which is what tells the
      // transport it has nothing to wait for.
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }

      const result = options.respond?.(message) ?? { echoed: message.method };
      response
        .writeHead(200, responseHeaders)
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    received,
    lastHeaders: () => headers,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
