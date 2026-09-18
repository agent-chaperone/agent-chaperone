import { describe, expect, it } from 'vitest';
import { inspect } from './jsonrpc.js';

describe('inspect', () => {
  it('classifies a request, keeping its id and method', () => {
    const envelope = inspect(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}',
    );
    expect(envelope.kind).toBe('request');
    expect(envelope.id).toBe(1);
    expect(envelope.method).toBe('tools/call');
  });

  it('treats a method without an id as a notification', () => {
    expect(inspect('{"jsonrpc":"2.0","method":"notifications/initialized"}').kind).toBe(
      'notification',
    );
  });

  it('classifies both result and error responses', () => {
    expect(inspect('{"jsonrpc":"2.0","id":1,"result":{}}').kind).toBe('response');
    expect(inspect('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"no"}}').kind).toBe(
      'response',
    );
  });

  it('accepts a string id as distinct from a number', () => {
    expect(inspect('{"jsonrpc":"2.0","id":"1","method":"ping"}').id).toBe('1');
  });

  it('reports unparseable input instead of throwing', () => {
    const envelope = inspect('{ not json');
    expect(envelope.kind).toBe('unparseable');
    expect(envelope.raw).toBe('{ not json');
  });

  it('does not correlate a batch, but keeps it intact', () => {
    const envelope = inspect('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
    expect(envelope.kind).toBe('other');
    expect(envelope.id).toBeUndefined();
  });

  it('keeps the raw line for every classification', () => {
    for (const line of ['{"jsonrpc":"2.0","id":1,"method":"a"}', 'garbage', '[]', '{"a":1}']) {
      expect(inspect(line).raw).toBe(line);
    }
  });

  it('ignores a null id, which JSON-RPC uses for an unmatched error', () => {
    const envelope = inspect('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"x"}}');
    expect(envelope.id).toBeUndefined();
  });
});
