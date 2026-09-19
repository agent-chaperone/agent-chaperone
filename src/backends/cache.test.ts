import { describe, expect, it } from 'vitest';
import { cachingBackend } from './cache.js';
import type { Backend, BackendResult, Battery } from './types.js';

const BATTERY = {
  destructive: {
    kind: 'noul' as const,
    instructions: 'Is this destructive?',
    criteria: { true: 'yes', false: 'no' },
  },
};

/** Counts what it was actually asked. */
function counting(answer: (at: number) => BackendResult<Battery>) {
  let calls = 0;
  const backend: Backend = {
    name: 'fake',
    ask: <const B extends Battery>(): Promise<BackendResult<B>> => {
      calls += 1;
      return Promise.resolve(answer(calls) as BackendResult<B>);
    },
  };
  return { backend, calls: () => calls };
}

const ok = (noul: number): BackendResult<Battery> => ({
  ok: true,
  answers: { destructive: { kind: 'noul', noul } },
  model: 'jev-1.13.0',
  inputTokens: 100,
  latencyMs: 40,
});

const down: BackendResult<Battery> = {
  ok: false,
  failure: { kind: 'unavailable', retryable: true, message: 'down' },
};

describe('asking the same question twice', () => {
  it('asks once and answers twice', async () => {
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend);

    const first = await cached.ask({ tool: 'shell' }, BATTERY);
    const second = await cached.ask({ tool: 'shell' }, BATTERY);

    expect(inner.calls()).toBe(1);
    expect(first.ok && second.ok && second.answers).toEqual(first.ok && first.answers);
  });

  it('asks again for a different state', async () => {
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend);

    await cached.ask({ tool: 'shell', arguments: { command: 'ls' } }, BATTERY);
    await cached.ask({ tool: 'shell', arguments: { command: 'rm -rf /' } }, BATTERY);

    expect(inner.calls()).toBe(2);
  });

  it('asks again for a different battery, since it is a different question', async () => {
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend);
    const other = {
      exfiltration: {
        kind: 'noul' as const,
        instructions: 'Does this send data out?',
        criteria: { true: 'yes', false: 'no' },
      },
    };

    await cached.ask({ tool: 'shell' }, BATTERY);
    await cached.ask({ tool: 'shell' }, other);

    expect(inner.calls()).toBe(2);
  });

  it('does not remember a failure, which is about the moment and not the question', async () => {
    let at = 0;
    const inner = counting(() => {
      at += 1;
      return at === 1 ? down : ok(0.5);
    });
    const cached = cachingBackend(inner.backend);

    const first = await cached.ask({ tool: 'shell' }, BATTERY);
    const second = await cached.ask({ tool: 'shell' }, BATTERY);

    // Caching a rate limit would turn one bad moment into a verdict that lasts
    // the rest of the session.
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(inner.calls()).toBe(2);
  });

  it('reports a cached answer as having cost nothing', async () => {
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend);

    const first = await cached.ask({ tool: 'shell' }, BATTERY);
    const second = await cached.ask({ tool: 'shell' }, BATTERY);

    // The first request really was sent and really did cost tokens. The second
    // was not, and a log that charged for it would be adding up a bill for
    // requests nobody made.
    expect(first.ok && first.inputTokens).toBe(100);
    expect(second.ok && second.inputTokens).toBe(0);
    expect(second.ok && second.latencyMs).toBe(0);
  });

  it('keeps the model, so a cached answer still says what judged it', async () => {
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend);
    await cached.ask({ tool: 'shell' }, BATTERY);
    const second = await cached.ask({ tool: 'shell' }, BATTERY);

    expect(second.ok && second.model).toBe('jev-1.13.0');
  });

  it('counts what it saved', async () => {
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend);
    await cached.ask({ tool: 'a' }, BATTERY);
    await cached.ask({ tool: 'a' }, BATTERY);
    await cached.ask({ tool: 'b' }, BATTERY);

    expect(cached.stats()).toEqual({ hits: 1, misses: 2, entries: 2 });
  });

  it('calls back on a hit, so a caller can say so', async () => {
    let hits = 0;
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend, { onHit: () => (hits += 1) });
    await cached.ask({ tool: 'a' }, BATTERY);
    await cached.ask({ tool: 'a' }, BATTERY);

    expect(hits).toBe(1);
  });

  it('forgets the oldest rather than growing without limit', async () => {
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend, { maxEntries: 3 });

    for (const tool of ['a', 'b', 'c', 'd']) {
      await cached.ask({ tool }, BATTERY);
    }
    await cached.ask({ tool: 'a' }, BATTERY);

    expect(cached.stats().entries).toBeLessThanOrEqual(3);
    expect(inner.calls()).toBe(5);
  });

  it('keeps a question that is asked repeatedly, rather than evicting it by age', async () => {
    const inner = counting(() => ok(0.9));
    const cached = cachingBackend(inner.backend, { maxEntries: 2 });

    await cached.ask({ tool: 'hot' }, BATTERY);
    await cached.ask({ tool: 'b' }, BATTERY);
    await cached.ask({ tool: 'hot' }, BATTERY);
    await cached.ask({ tool: 'c' }, BATTERY);
    const before = inner.calls();
    await cached.ask({ tool: 'hot' }, BATTERY);

    expect(inner.calls()).toBe(before);
  });

  it('keeps the backend name, since that is what the log records', () => {
    const inner = counting(() => ok(0.9));

    expect(cachingBackend(inner.backend).name).toBe('fake');
  });
});
