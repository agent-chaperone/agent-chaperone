import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createProxy, type Gate, type GateVerdict, type ProxyEvent } from './proxy.js';
import { readLines } from './__fixtures__/streams.js';

function harness(gate: Gate) {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const upstreamInput = new PassThrough();
  const upstreamOutput = new PassThrough();
  const events: ProxyEvent[] = [];
  const proxy = createProxy(
    { clientInput, clientOutput, upstreamInput, upstreamOutput },
    { gate, now: () => 1700000000000, onEvent: (event) => events.push(event) },
  );
  return { clientInput, clientOutput, upstreamInput, upstreamOutput, events, proxy };
}

const forward: GateVerdict = { kind: 'forward' };
const line = (id: number) => `{"jsonrpc":"2.0","id":${id},"method":"ping"}`;

describe('a gate that answers immediately', () => {
  it('costs the message nothing, because nothing is awaited', async () => {
    const h = harness(() => forward);

    h.clientInput.write(`${line(1)}\n`);

    // Readable in the same turn: a promise anywhere in this path would push the
    // write into a later microtask and this would come back empty.
    expect(h.upstreamInput.read()?.toString()).toBe(`${line(1)}\n`);
  });
});

describe('what a verdict does', () => {
  it('replaces the message with the one the gate supplied', async () => {
    const h = harness(() => ({ kind: 'replace', raw: '{"replaced":true}' }));

    h.clientInput.write(`${line(1)}\n`);

    expect(await readLines(h.upstreamInput, 1)).toEqual(['{"replaced":true}']);
  });

  it('drops the message and tells nobody it arrived anywhere', async () => {
    const h = harness(() => ({ kind: 'drop' }));

    h.clientInput.write(`${line(1)}\n`);
    await Promise.resolve();

    expect(h.upstreamInput.read()).toBeNull();
    const message = h.events.find((event) => event.type === 'message');
    expect(message).toMatchObject({ verdict: 'drop', delivered: false });
  });

  it('answers the peer that sent it, without forwarding anything', async () => {
    const h = harness(() => ({ kind: 'answer', raw: '{"answered":true}' }));

    h.clientInput.write(`${line(1)}\n`);

    expect(await readLines(h.clientOutput, 1)).toEqual(['{"answered":true}']);
    expect(h.upstreamInput.read()).toBeNull();
  });

  it('does not correlate a request the upstream never received', async () => {
    const h = harness((envelope) =>
      envelope.method === 'tools/call' ? { kind: 'answer', raw: '{"held":true}' } : forward,
    );
    h.clientInput.write(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}\n`);
    await readLines(h.clientOutput, 1);

    // A reply to a call that never went upstream cannot be paired with it, so
    // the correlator must not be holding one.
    h.upstreamOutput.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await readLines(h.clientOutput, 1);

    const response = h.events.find(
      (event) => event.type === 'message' && event.direction === 'upstream-to-client',
    );
    expect(response).toMatchObject({ request: undefined });
  });
});

describe('a gate that takes its time', () => {
  const slow =
    (ms: number): Gate =>
    async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return forward;
    };

  it('keeps messages in the order they arrived', async () => {
    const h = harness(async (envelope) => {
      // The first decision takes longer than the second, so anything that does
      // not queue would deliver them backwards.
      await new Promise((resolve) => setTimeout(resolve, envelope.id === 1 ? 20 : 1));
      return forward;
    });

    h.clientInput.write(`${line(1)}\n${line(2)}\n`);

    expect(await readLines(h.upstreamInput, 2)).toEqual([line(1), line(2)]);
  });

  it('delivers what it decided even when the source ends first', async () => {
    const h = harness(slow(20));

    h.clientInput.write(`${line(1)}\n`);
    h.clientInput.end();

    // The source is done before the verdict is. Closing the direction on `end`
    // would throw the message away after the peers were told nothing.
    expect(await readLines(h.upstreamInput, 1)).toEqual([line(1)]);
  });

  it('stops reading while a decision is pending', async () => {
    let seen = 0;
    const h = harness(async () => {
      seen += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return forward;
    });

    h.clientInput.write(`${line(1)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.clientInput.write(`${line(2)}\n${line(3)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Only the first has been handed to the gate; the rest are still in the
    // stream rather than queued in memory behind it.
    expect(seen).toBe(1);
    expect(await readLines(h.upstreamInput, 3)).toEqual([line(1), line(2), line(3)]);
  });
});

describe('a gate that fails', () => {
  it('forwards the message and reports the fault when it throws outright', async () => {
    const h = harness(() => {
      throw new Error('gate exploded');
    });

    h.clientInput.write(`${line(1)}\n`);

    expect(await readLines(h.upstreamInput, 1)).toEqual([line(1)]);
    expect(h.events.find((event) => event.type === 'stream-error')).toMatchObject({
      error: { message: 'gate exploded' },
    });
  });

  it('forwards the message when its promise rejects', async () => {
    const h = harness(() => Promise.reject(new Error('gate rejected')));

    h.clientInput.write(`${line(1)}\n`);

    expect(await readLines(h.upstreamInput, 1)).toEqual([line(1)]);
    expect(h.events.find((event) => event.type === 'stream-error')).toMatchObject({
      error: { message: 'gate rejected' },
    });
  });
});
