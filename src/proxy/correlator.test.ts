import { describe, expect, it } from 'vitest';
import { RequestCorrelator } from './correlator.js';
import { inspect } from './jsonrpc.js';

const request = (id: number | string, method = 'tools/call'): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: { name: 'x' } });
const response = (id: number | string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result: {} });

describe('RequestCorrelator', () => {
  it('pairs a response with the request that produced it', () => {
    const correlator = new RequestCorrelator();
    correlator.record(inspect(request(1)), 1000);
    const matched = correlator.take(inspect(response(1)));
    expect(matched?.method).toBe('tools/call');
    expect(matched?.receivedAt).toBe(1000);
  });

  it('consumes the pairing, so a duplicate response matches nothing', () => {
    const correlator = new RequestCorrelator();
    correlator.record(inspect(request(1)), 0);
    expect(correlator.take(inspect(response(1)))).toBeDefined();
    expect(correlator.take(inspect(response(1)))).toBeUndefined();
    expect(correlator.size).toBe(0);
  });

  it('matches out-of-order responses to the right requests', () => {
    const correlator = new RequestCorrelator();
    correlator.record(inspect(request(1, 'tools/list')), 0);
    correlator.record(inspect(request(2, 'tools/call')), 0);
    correlator.record(inspect(request(3, 'resources/read')), 0);
    expect(correlator.take(inspect(response(3)))?.method).toBe('resources/read');
    expect(correlator.take(inspect(response(1)))?.method).toBe('tools/list');
    expect(correlator.take(inspect(response(2)))?.method).toBe('tools/call');
  });

  it('keeps a numeric id separate from the same digits as a string', () => {
    const correlator = new RequestCorrelator();
    correlator.record(inspect(request(1, 'numeric')), 0);
    correlator.record(inspect(request('1', 'stringy')), 0);
    expect(correlator.take(inspect(response('1')))?.method).toBe('stringy');
    expect(correlator.take(inspect(response(1)))?.method).toBe('numeric');
  });

  it('ignores notifications, which never get a response', () => {
    const correlator = new RequestCorrelator();
    correlator.record(inspect('{"jsonrpc":"2.0","method":"notifications/initialized"}'), 0);
    expect(correlator.size).toBe(0);
  });

  it('drops the oldest entry rather than growing without limit', () => {
    const correlator = new RequestCorrelator(2);
    correlator.record(inspect(request(1)), 0);
    correlator.record(inspect(request(2)), 0);
    correlator.record(inspect(request(3)), 0);
    expect(correlator.size).toBe(2);
    expect(correlator.take(inspect(response(1)))).toBeUndefined();
    expect(correlator.take(inspect(response(3)))).toBeDefined();
  });

  it('returns nothing for a response to a request it never saw', () => {
    expect(new RequestCorrelator().take(inspect(response(99)))).toBeUndefined();
  });
});

describe('RequestCorrelator bounds', () => {
  it('bounds the bytes it holds, not just the number of entries', () => {
    const correlator = new RequestCorrelator({ maxPending: 100, maxPendingBytes: 400 });
    for (let i = 0; i < 20; i += 1) {
      correlator.record(
        inspect(
          JSON.stringify({ jsonrpc: '2.0', id: i, method: 'x', params: { pad: 'y'.repeat(100) } }),
        ),
        0,
      );
    }
    expect(correlator.byteSize).toBeLessThanOrEqual(400);
    expect(correlator.size).toBeLessThan(20);
  });

  it('refuses to pair an id too large to round-trip, rather than pairing the wrong one', () => {
    const correlator = new RequestCorrelator();
    correlator.record(inspect('{"jsonrpc":"2.0","id":9007199254740993,"method":"first"}'), 0);
    correlator.record(inspect('{"jsonrpc":"2.0","id":9007199254740992,"method":"second"}'), 0);
    expect(
      correlator.take(inspect('{"jsonrpc":"2.0","id":9007199254740993,"result":{}}')),
    ).toBeUndefined();
  });

  it('still pairs ordinary ids at the edge of the safe range', () => {
    const correlator = new RequestCorrelator();
    correlator.record(inspect('{"jsonrpc":"2.0","id":9007199254740991,"method":"safe"}'), 0);
    expect(
      correlator.take(inspect('{"jsonrpc":"2.0","id":9007199254740991,"result":{}}'))?.method,
    ).toBe('safe');
  });

  it('replaces a repeated id rather than double-counting its bytes', () => {
    const correlator = new RequestCorrelator();
    const line = '{"jsonrpc":"2.0","id":1,"method":"x"}';
    correlator.record(inspect(line), 0);
    const once = correlator.byteSize;
    correlator.record(inspect(line), 0);
    expect(correlator.byteSize).toBe(once);
    expect(correlator.size).toBe(1);
  });
});
