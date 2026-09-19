import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from './proxy.js';
import { RequestCorrelator } from './correlator.js';
import { readLines } from './__fixtures__/streams.js';
import { BlockingSink, FailingSink, tick } from './__fixtures__/sinks.js';

function harness(
  options: { maxLineBytes?: number; maxPending?: number; maxPendingBytes?: number } = {},
) {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const upstreamInput = new PassThrough();
  const upstreamOutput = new PassThrough();
  const events: ProxyEvent[] = [];
  const proxy = createProxy(
    { clientInput, clientOutput, upstreamInput, upstreamOutput },
    { ...options, now: () => 1700000000000, onEvent: (event) => events.push(event) },
  );
  return { clientInput, clientOutput, upstreamInput, upstreamOutput, events, proxy };
}

describe('createProxy', () => {
  it('relays a client message to the upstream byte for byte', async () => {
    const h = harness();
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    h.clientInput.write(`${line}\n`);
    expect(await readLines(h.upstreamInput, 1)).toEqual([line]);
  });

  it('relays an upstream message back to the client byte for byte', async () => {
    const h = harness();
    const line = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
    h.upstreamOutput.write(`${line}\n`);
    expect(await readLines(h.clientOutput, 1)).toEqual([line]);
  });

  it('passes through a request carrying an unknown top-level field', async () => {
    // The MCP SDK's own framing rejects this, because its request schema is
    // strict. A proxy that refused it would break any protocol extension.
    const h = harness();
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{},"vendorField":"keep"}';
    h.clientInput.write(`${line}\n`);
    expect(await readLines(h.upstreamInput, 1)).toEqual([line]);
  });

  it('preserves key order and spacing rather than reserialising', async () => {
    const h = harness();
    const line = '{  "method":"ping", "jsonrpc":"2.0",  "id":7 }';
    h.clientInput.write(`${line}\n`);
    expect(await readLines(h.upstreamInput, 1)).toEqual([line]);
  });

  it('relays a line that is not JSON at all', async () => {
    const h = harness();
    h.upstreamOutput.write('this is not json\n');
    expect(await readLines(h.clientOutput, 1)).toEqual(['this is not json']);
    const message = h.events.find((event) => event.type === 'message');
    expect(message?.type === 'message' && message.envelope.kind).toBe('unparseable');
  });

  it('hands a response back with the request it answers', async () => {
    const h = harness();
    h.clientInput.write('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rm"}}\n');
    await readLines(h.upstreamInput, 1);
    h.upstreamOutput.write('{"jsonrpc":"2.0","id":4,"result":{"ok":true}}\n');
    await readLines(h.clientOutput, 1);

    const inbound = h.events.filter(
      (event) => event.type === 'message' && event.direction === 'upstream-to-client',
    );
    const first = inbound[0];
    expect(first?.type === 'message' && first.request?.method).toBe('tools/call');
    expect(first?.type === 'message' && first.request?.receivedAt).toBe(1700000000000);
  });

  it('correlates interleaved calls to the right requests', async () => {
    const h = harness();
    h.clientInput.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    h.clientInput.write('{"jsonrpc":"2.0","id":2,"method":"resources/read"}\n');
    await readLines(h.upstreamInput, 2);
    h.upstreamOutput.write('{"jsonrpc":"2.0","id":2,"result":{}}\n');
    h.upstreamOutput.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await readLines(h.clientOutput, 2);

    const methods = h.events
      .filter((event) => event.type === 'message' && event.direction === 'upstream-to-client')
      .map((event) => (event.type === 'message' ? event.request?.method : undefined));
    expect(methods).toEqual(['resources/read', 'tools/list']);
  });

  it('relays several messages arriving in one chunk, in order', async () => {
    const h = harness();
    h.clientInput.write(
      '{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n',
    );
    expect(await readLines(h.upstreamInput, 2)).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"a"}',
      '{"jsonrpc":"2.0","id":2,"method":"b"}',
    ]);
  });

  it('closes the upstream input when the client goes away, so the server can exit', async () => {
    const h = harness();
    const ended = new Promise<void>((resolve) => h.upstreamInput.on('end', () => resolve()));
    h.upstreamInput.resume();
    h.clientInput.end();
    await expect(ended).resolves.toBeUndefined();
  });

  it('reports an oversized message and stops that direction', async () => {
    const h = harness({ maxLineBytes: 64 });
    h.clientInput.write(`${'x'.repeat(500)}\n`);
    await h.proxy.closed;
    const failure = h.events.find((event) => event.type === 'stream-error');
    expect(failure?.type === 'stream-error' && failure.direction).toBe('client-to-upstream');
    expect(failure?.type === 'stream-error' && failure.error.name).toBe('LineTooLongError');
  });

  it('resolves once both directions have finished', async () => {
    const h = harness();
    h.clientInput.end();
    h.upstreamOutput.end();
    await expect(h.proxy.closed).resolves.toBeUndefined();
  });
});

describe('when a peer goes away mid-write', () => {
  it('ends the session quietly on EPIPE instead of throwing', async () => {
    const clientInput = new PassThrough();
    const events: ProxyEvent[] = [];
    const upstreamOutput = new PassThrough();
    const proxy = createProxy(
      {
        clientInput,
        clientOutput: new PassThrough(),
        upstreamInput: new FailingSink('EPIPE'),
        upstreamOutput,
      },
      { onEvent: (event) => events.push(event) },
    );
    clientInput.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await tick();
    await tick();
    // A closed pipe is the peer leaving, not a fault of this program, so it
    // ends the direction without raising and without a stream-error event.
    expect(events.filter((event) => event.type === 'stream-error')).toEqual([]);
    const message = events.find((event) => event.type === 'message');
    expect(message?.type === 'message' && message.delivered).toBe(true);
    upstreamOutput.end();
    clientInput.end();
    await expect(proxy.closed).resolves.toBeUndefined();
  });

  it('reports a stream failure that is not just a closed pipe', async () => {
    const clientInput = new PassThrough();
    const events: ProxyEvent[] = [];
    createProxy(
      {
        clientInput,
        clientOutput: new PassThrough(),
        upstreamInput: new FailingSink('EACCES'),
        upstreamOutput: new PassThrough(),
      },
      { onEvent: (event) => events.push(event) },
    );
    clientInput.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await tick();
    await tick();
    const failure = events.find((event) => event.type === 'stream-error');
    expect(failure?.type === 'stream-error' && failure.direction).toBe('client-to-upstream');
  });

  it('reports a message as undelivered rather than claiming it was relayed', async () => {
    const clientInput = new PassThrough();
    const upstreamInput = new PassThrough();
    const events: ProxyEvent[] = [];
    createProxy(
      {
        clientInput,
        clientOutput: new PassThrough(),
        upstreamInput,
        upstreamOutput: new PassThrough(),
      },
      { onEvent: (event) => events.push(event) },
    );
    upstreamInput.destroy();
    await tick();
    clientInput.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await tick();
    const message = events.find((event) => event.type === 'message');
    expect(message?.type === 'message' && message.delivered).toBe(false);
  });
});

describe('backpressure', () => {
  it('pauses the source while the sink is full and resumes when it drains', async () => {
    const clientInput = new PassThrough();
    const sink = new BlockingSink();
    createProxy({
      clientInput,
      clientOutput: new PassThrough(),
      upstreamInput: sink,
      upstreamOutput: new PassThrough(),
    });

    clientInput.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
    await tick();
    expect(sink.chunks).toHaveLength(1);
    expect(clientInput.isPaused()).toBe(true);

    clientInput.write('{"jsonrpc":"2.0","id":2,"method":"b"}\n');
    await tick();
    expect(sink.chunks).toHaveLength(1);

    sink.release();
    await tick();
    await tick();
    expect(sink.chunks).toHaveLength(2);

    // It pauses again straight away, because relaying the second line filled
    // the sink once more. Draining it a second time lets the source run on.
    sink.release();
    await tick();
    await tick();
    expect(clientInput.isPaused()).toBe(false);
  });
});

describe('shutdown', () => {
  it('lets the upstream flush a last reply after the client disconnects', async () => {
    const h = harness();
    h.clientInput.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await readLines(h.upstreamInput, 1);
    h.clientInput.end();
    await tick();
    h.upstreamOutput.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(await readLines(h.clientOutput, 1)).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  it('stops relaying when close() is called', async () => {
    const h = harness();
    h.proxy.close();
    await h.proxy.closed;
    h.clientInput.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await tick();
    expect(h.events.filter((event) => event.type === 'message')).toEqual([]);
  });
});

describe('a pending request dropped to stay in bounds', () => {
  const line = (id: number, method: string, pad = '') =>
    JSON.stringify({ jsonrpc: '2.0', id, method, params: { pad } });

  const envelopeOf = (id: number, method: string, pad = '') => {
    const raw = line(id, method, pad);
    return {
      kind: 'request' as const,
      id,
      method,
      raw,
      value: JSON.parse(raw) as unknown,
    };
  };

  it('says what it dropped when the count bound is reached', () => {
    // A peer can spend cheap requests to push out the one entry whose pairing
    // mattered. The bound has to hold; doing it in silence does not.
    const seen: string[] = [];
    const correlator = new RequestCorrelator({
      maxPending: 2,
      onEvict: (one) => seen.push(`${one.request.method}:${one.reason}`),
    });

    correlator.record(envelopeOf(1, 'tools/call'), 0);
    correlator.record(envelopeOf(2, 'resources/read'), 1);
    correlator.record(envelopeOf(3, 'tools/call'), 2);

    expect(seen).toEqual(['tools/call:count']);
  });

  it('says what it dropped when the byte bound is reached', () => {
    const seen: string[] = [];
    const correlator = new RequestCorrelator({
      maxPending: 1000,
      maxPendingBytes: 400,
      onEvict: (one) => seen.push(`${one.request.method}:${one.reason}`),
    });

    correlator.record(envelopeOf(1, 'tools/call', 'x'.repeat(200)), 0);
    correlator.record(envelopeOf(2, 'resources/read', 'y'.repeat(200)), 1);

    expect(seen).toEqual(['tools/call:bytes']);
  });

  it('keeps the bound even when the reporter throws', () => {
    // The report is a diagnostic. It must not be able to leave the map over the
    // limit it exists to describe.
    const correlator = new RequestCorrelator({
      maxPending: 2,
      onEvict: () => {
        throw new Error('reporter is broken');
      },
    });

    correlator.record(envelopeOf(1, 'tools/call'), 0);
    correlator.record(envelopeOf(2, 'tools/call'), 1);
    expect(() => correlator.record(envelopeOf(3, 'tools/call'), 2)).toThrow('reporter is broken');
    expect(correlator.size).toBeLessThanOrEqual(2);
  });

  it('reports it on the event seam, past both bounds', async () => {
    const h = harness({ maxPending: 2 });
    for (let id = 1; id <= 5; id += 1) {
      h.clientInput.write(`${line(id, 'tools/call')}\n`);
    }
    await readLines(h.upstreamInput, 5);

    const evictions = h.events.filter((one) => one.type === 'correlator-eviction');
    expect(evictions.length).toBeGreaterThan(0);
    expect(evictions[0]).toMatchObject({ reason: 'count' });

    const byBytes = harness({ maxPending: 1000, maxPendingBytes: 400 });
    byBytes.clientInput.write(`${line(1, 'tools/call', 'x'.repeat(200))}\n`);
    byBytes.clientInput.write(`${line(2, 'resources/read', 'y'.repeat(200))}\n`);
    await readLines(byBytes.upstreamInput, 2);

    expect(
      byBytes.events.filter((one) => one.type === 'correlator-eviction').map((one) => one.reason),
    ).toEqual(['bytes']);
  });
});
