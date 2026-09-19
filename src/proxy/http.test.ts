import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createProxy } from './proxy.js';
import {
  UnsendableLineError,
  UpstreamConnectError,
  UpstreamProtocolError,
  connectHttpUpstream,
  type UpstreamTransport,
} from './http.js';
import { readLines } from './__fixtures__/streams.js';
import { startFakeMcpServer } from './__fixtures__/http-server.js';

const URL_ = new URL('https://example.test/mcp');

interface FakeOptions {
  readonly failStart?: Error;
  readonly sendDelayMs?: (index: number) => number;
  readonly failSend?: Error;
  readonly terminate?: boolean;
}

/** A transport that records what it was asked to do, in the order it was asked. */
function fakeTransport(options: FakeOptions = {}) {
  const sent: JSONRPCMessage[] = [];
  const calls: string[] = [];
  let index = 0;
  const transport: UpstreamTransport & { headers?: Record<string, string> } = {
    async start(): Promise<void> {
      calls.push('start');
      if (options.failStart) {
        throw options.failStart;
      }
    },
    async send(message: JSONRPCMessage): Promise<void> {
      const wait = options.sendDelayMs?.(index++) ?? 0;
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      if (options.failSend) {
        throw options.failSend;
      }
      sent.push(message);
    },
    async close(): Promise<void> {
      calls.push('close');
    },
  };
  if (options.terminate !== false) {
    transport.terminateSession = async (): Promise<void> => {
      calls.push('terminateSession');
    };
  }
  return { transport, sent, calls };
}

function connectFake(options: FakeOptions = {}, headers: Record<string, string> = {}) {
  const fake = fakeTransport(options);
  let seenHeaders: Readonly<Record<string, string>> | undefined;
  const upstream = connectHttpUpstream(URL_, {
    headers,
    connect: (_url, given) => {
      seenHeaders = given;
      return fake.transport;
    },
  });
  return { ...fake, upstream, seenHeaders: () => seenHeaders };
}

describe('connectHttpUpstream', () => {
  it('parses each line written to stdin and sends it as one message', async () => {
    const h = connectFake();
    h.upstream.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));

    expect(h.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  });

  it('frames every message from the server back onto stdout', async () => {
    const h = connectFake();
    h.transport.onmessage?.({ jsonrpc: '2.0', id: 1, result: { tools: [] } } as JSONRPCMessage);
    const lines = await readLines(h.upstream.stdout, 1);

    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  it('keeps messages in the order the client wrote them when the server is slow', async () => {
    // The first send is the slowest, so anything that does not serialise sends
    // delivers them backwards.
    const h = connectFake({ sendDelayMs: (i) => (i === 0 ? 30 : 0) });
    h.upstream.stdin.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
    h.upstream.stdin.write('{"jsonrpc":"2.0","id":2,"method":"b"}\n');
    h.upstream.stdin.write('{"jsonrpc":"2.0","id":3,"method":"c"}\n');
    await vi.waitFor(() => expect(h.sent).toHaveLength(3));

    expect(h.sent.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
  });

  it('reassembles a message split across two chunks', async () => {
    const h = connectFake();
    h.upstream.stdin.write('{"jsonrpc":"2.0","id":7,"meth');
    h.upstream.stdin.write('od":"tools/list"}\n');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));

    expect(h.sent[0]).toEqual({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  });

  it('ends the session rather than silently dropping a line that is not JSON', async () => {
    const h = connectFake();
    const failed = new Promise<Error>((resolve) => {
      h.upstream.stdin.on('error', resolve);
    });
    h.upstream.stdin.write('this is not json\n');

    await expect(failed).resolves.toBeInstanceOf(UnsendableLineError);
    expect(h.sent).toHaveLength(0);
  });

  it('refuses a line larger than the cap instead of sending it', async () => {
    const fake = fakeTransport();
    const upstream = connectHttpUpstream(URL_, {
      maxLineBytes: 64,
      connect: () => fake.transport,
    });
    const failed = new Promise<Error>((resolve) => {
      upstream.stdin.on('error', resolve);
    });
    upstream.stdin.write(`{"jsonrpc":"2.0","id":1,"method":"${'x'.repeat(200)}"}\n`);

    await expect(failed).resolves.toBeInstanceOf(Error);
    expect(fake.sent).toHaveLength(0);
  });

  it('reports a connection that never comes up through exited', async () => {
    const h = connectFake({ failStart: new Error('connect ECONNREFUSED') });

    await expect(h.upstream.exited).rejects.toBeInstanceOf(UpstreamConnectError);
  });

  it('names the server in the message when the connection fails', async () => {
    const h = connectFake({ failStart: new Error('connect ECONNREFUSED') });

    await expect(h.upstream.exited).rejects.toThrow(/example\.test\/mcp/);
  });

  it('destroys the output stream when the transport reports an error', async () => {
    const h = connectFake();
    const failed = new Promise<Error>((resolve) => {
      h.upstream.stdout.on('error', resolve);
    });
    h.transport.onerror?.(new Error('stream reset'));

    await expect(failed).resolves.toBeInstanceOf(UpstreamProtocolError);
    await expect(h.upstream.exited).resolves.toBe(1);
  });

  it('exits zero when the server closes the session cleanly', async () => {
    const h = connectFake();
    h.transport.onclose?.();

    await expect(h.upstream.exited).resolves.toBe(0);
  });

  it('deletes the session before closing, so the server is not left holding it', async () => {
    const h = connectFake();
    h.upstream.kill();

    await expect(h.upstream.exited).resolves.toBe(0);
    expect(h.calls).toEqual(['start', 'terminateSession', 'close']);
  });

  it('still closes when the server does not support deleting the session', async () => {
    const h = connectFake({ terminate: false });
    h.upstream.kill();

    await expect(h.upstream.exited).resolves.toBe(0);
    expect(h.calls).toEqual(['start', 'close']);
  });

  it('sends exactly the headers it was given and adds nothing', () => {
    const h = connectFake({}, { Authorization: 'Bearer t' });

    expect(h.seenHeaders()).toEqual({ Authorization: 'Bearer t' });
  });

  it('does not reach for the chaperone credentials that the stdio path withholds', () => {
    process.env.TYPESAFE_API_KEY = 'sk-should-never-be-forwarded';
    try {
      const h = connectFake();

      expect(JSON.stringify(h.seenHeaders())).not.toContain('should-never-be-forwarded');
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });
});

describe('the relay over an HTTP upstream', () => {
  it('carries a request out and its response back without the proxy knowing the difference', async () => {
    const h = connectFake();
    const clientInput = new PassThrough();
    const clientOutput = new PassThrough();
    createProxy({
      clientInput,
      clientOutput,
      upstreamInput: h.upstream.stdin,
      upstreamOutput: h.upstream.stdout,
    });

    clientInput.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.transport.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'read_file' }] },
    } as JSONRPCMessage);
    const replies = await readLines(clientOutput, 1);

    expect(h.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(JSON.parse(replies[0] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'read_file' }] },
    });
  });
});

describe('against a server that really speaks HTTP', () => {
  it('carries a request to the server and its response back to the client', async () => {
    const server = await startFakeMcpServer();
    try {
      const upstream = connectHttpUpstream(server.url);
      const clientInput = new PassThrough();
      const clientOutput = new PassThrough();
      createProxy({
        clientInput,
        clientOutput,
        upstreamInput: upstream.stdin,
        upstreamOutput: upstream.stdout,
      });

      clientInput.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
      const replies = await readLines(clientOutput, 1, 5000);

      expect(server.received).toEqual([
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      ]);
      expect(JSON.parse(replies[0] ?? '{}')).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { echoed: 'tools/list' },
      });
      upstream.kill();
    } finally {
      await server.close();
    }
  });

  it('sends the headers it was given on the real request', async () => {
    const server = await startFakeMcpServer();
    try {
      const upstream = connectHttpUpstream(server.url, {
        headers: { Authorization: 'Bearer test-token' },
      });
      upstream.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      await vi.waitFor(() => expect(server.received).toHaveLength(1), { timeout: 5000 });

      expect(server.lastHeaders()['authorization']).toBe('Bearer test-token');
      upstream.kill();
    } finally {
      await server.close();
    }
  });

  it('echoes the session id the server assigned on every later request', async () => {
    const server = await startFakeMcpServer({ session: 'session-abc' });
    try {
      const upstream = connectHttpUpstream(server.url);
      upstream.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
      await vi.waitFor(() => expect(server.received).toHaveLength(1), { timeout: 5000 });
      upstream.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
      await vi.waitFor(() => expect(server.received).toHaveLength(2), { timeout: 5000 });

      expect(server.lastHeaders()['mcp-session-id']).toBe('session-abc');
      upstream.kill();
    } finally {
      await server.close();
    }
  });

  it('reports a server that refuses the connection rather than relaying nothing', async () => {
    const server = await startFakeMcpServer({ status: 401 });
    const url = server.url;
    try {
      const upstream = connectHttpUpstream(url);
      const failed = new Promise<Error>((resolve) => {
        upstream.stdin.on('error', resolve);
        upstream.stdout.on('error', resolve);
      });
      upstream.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');

      await expect(failed).resolves.toBeInstanceOf(Error);
    } finally {
      await server.close();
    }
  });

  it('does not turn its own shutdown into a reported fault when the server has gone', async () => {
    const server = await startFakeMcpServer();
    const upstream = connectHttpUpstream(server.url);
    upstream.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await vi.waitFor(() => expect(server.received).toHaveLength(1), { timeout: 5000 });
    // The server disappears first, so deleting the session cannot succeed. That
    // is an ordinary end of session, not a screening failure, and it must not
    // reach the process as an unhandled error either.
    await server.close();
    upstream.kill();

    await expect(upstream.exited).resolves.toBe(0);
  });

  it('reports a host that is not listening at all', async () => {
    // Port 1 on loopback: reserved, and nothing this suite starts can hold it.
    const upstream = connectHttpUpstream(new URL('http://127.0.0.1:1/mcp'));
    const failed = new Promise<Error>((resolve) => {
      upstream.stdin.on('error', resolve);
      upstream.stdout.on('error', resolve);
    });
    upstream.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');

    await expect(failed).resolves.toBeInstanceOf(Error);
  });
});
