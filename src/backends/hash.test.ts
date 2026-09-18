import { describe, expect, it } from 'vitest';
import { requestHash } from './hash.js';
import type { Battery } from './types.js';

const battery: Battery = {
  destructive: { kind: 'noul', instructions: 'Does it delete anything?' },
};

describe('requestHash', () => {
  it('ignores the order the state was built in', () => {
    const one = requestHash({ tool: 'rm', args: { path: '/tmp' } }, battery);
    const two = requestHash({ args: { path: '/tmp' }, tool: 'rm' }, battery);
    expect(one).toBe(two);
  });

  it('ignores the order the questions were declared in', () => {
    const asked: Battery = {
      a: { kind: 'noul', instructions: 'first' },
      b: { kind: 'noul', instructions: 'second' },
    };
    const reordered: Battery = {
      b: { kind: 'noul', instructions: 'second' },
      a: { kind: 'noul', instructions: 'first' },
    };
    expect(requestHash('x', asked)).toBe(requestHash('x', reordered));
  });

  it('changes when a question is reworded, so a fixture cannot outlive its wording', () => {
    const reworded: Battery = {
      destructive: { kind: 'noul', instructions: 'Does it delete anything at all?' },
    };
    expect(requestHash('x', battery)).not.toBe(requestHash('x', reworded));
  });

  it('changes with the state', () => {
    expect(requestHash({ tool: 'rm' }, battery)).not.toBe(requestHash({ tool: 'ls' }, battery));
  });

  it('keeps array order, which is meaning and not layout', () => {
    expect(requestHash([1, 2], battery)).not.toBe(requestHash([2, 1], battery));
  });

  it('treats an absent state as the null a backend would send', () => {
    expect(requestHash(undefined, battery)).toBe(requestHash(null, battery));
  });

  it('does not confuse a nested key order change with a value change', () => {
    const deep = requestHash({ a: { z: 1, y: { q: 2, p: 3 } } }, battery);
    const same = requestHash({ a: { y: { p: 3, q: 2 }, z: 1 } }, battery);
    expect(deep).toBe(same);
  });
});

describe('requestHash on states a caller controls', () => {
  it('is pinned to one digest, so a change that invalidates every recording is visible', () => {
    // A recording on disk is keyed by this string. Changing the algorithm or the
    // canonical form silently orphans every fixture, so the value is written out.
    expect(requestHash({ tool: 'rm' }, battery)).toBe(
      '2dd21cc958d51758fb8a03ca7cc87d1e6225e49b608555d2f3f0316b029c8dd8',
    );
  });

  it('sees a __proto__ key that came off the wire', () => {
    const hostile: unknown = JSON.parse('{"a":1,"__proto__":{"command":"rm -rf /"}}');
    expect(requestHash(hostile, battery)).not.toBe(requestHash({ a: 1 }, battery));
  });

  it('separates two dates, which JSON would have sent as two different strings', () => {
    const one = requestHash({ at: new Date('2020-01-01T00:00:00Z') }, battery);
    const two = requestHash({ at: new Date('2031-12-25T00:00:00Z') }, battery);
    expect(one).not.toBe(two);
  });

  it('hashes what a backend would receive, so a property JSON drops is not part of it', () => {
    expect(requestHash({ a: 1, b: undefined }, battery)).toBe(requestHash({ a: 1 }, battery));
    expect(requestHash({ a: 1, b: null }, battery)).not.toBe(requestHash({ a: 1 }, battery));
  });

  it.each([
    ['a bigint', { count: 10n }],
    ['a function', { run: () => undefined }],
    ['a symbol', { tag: Symbol('x') }],
    ['an infinity', { ratio: Number.POSITIVE_INFINITY }],
  ])('does not throw on %s', (_name, state) => {
    expect(() => requestHash(state, battery)).not.toThrow();
  });

  it('does not throw on a cycle', () => {
    const state: Record<string, unknown> = { tool: 'rm' };
    state['self'] = state;
    expect(() => requestHash(state, battery)).not.toThrow();
  });

  it('does not throw on a state deeper than it will walk', () => {
    let state: unknown = 'bottom';
    for (let depth = 0; depth < 5_000; depth += 1) {
      state = { next: state };
    }
    expect(() => requestHash(state, battery)).not.toThrow();
  });

  it('repeats a shared branch without calling it a cycle', () => {
    const shared = { path: '/etc' };
    expect(requestHash({ a: shared, b: shared }, battery)).toBe(
      requestHash({ a: { path: '/etc' }, b: { path: '/etc' } }, battery),
    );
  });
});
