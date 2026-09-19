import { describe, expect, it } from 'vitest';
import { formatReplay, formatSummary, replay, summarise } from './index.js';
import { parsePolicy } from '../policy/index.js';
import type { AuditRecord } from '../audit/index.js';

const call = (over: Partial<Record<string, unknown>> = {}): AuditRecord =>
  ({
    ts: '2026-05-05T09:00:00.000Z',
    id: 'a1',
    server: 'files',
    kind: 'call',
    tool: 'shell',
    mode: 'shadow',
    decision: 'forward',
    intended: { kind: 'forward' },
    applied: { kind: 'forward' },
    screened: true,
    answers: {},
    rules: {},
    secrets: [],
    ...over,
  }) as AuditRecord;

const result = (over: Partial<Record<string, unknown>> = {}): AuditRecord =>
  ({
    ...(call() as unknown as Record<string, unknown>),
    kind: 'result',
    id: 'r1',
    decision: 'pass',
    intended: { kind: 'pass' },
    applied: { kind: 'pass' },
    ...over,
  }) as AuditRecord;

describe('what a log adds up to', () => {
  it('says there is nothing rather than printing an empty table', () => {
    expect(formatSummary(summarise([]))).toContain('Nothing recorded yet');
  });

  it('counts each kind of record', () => {
    const summary = summarise([
      call(),
      result(),
      {
        ts: '2026-05-05T09:00:01.000Z',
        kind: 'eviction',
        server: 'files',
        id: '3',
        method: 'x',
        reason: 'count',
      } as AuditRecord,
    ]);

    expect(summary.calls).toBe(1);
    expect(summary.results).toBe(1);
    expect(summary.evictions).toBe(1);
  });

  it('counts what enforcing would have stopped, which is the shadow-mode question', () => {
    const summary = summarise([
      call({ intended: { kind: 'hold' }, applied: { kind: 'forward' } }),
      call({ intended: { kind: 'block' }, applied: { kind: 'forward' } }),
      call(),
    ]);

    expect(summary.wouldStop).toEqual([
      { decision: 'block', count: 1 },
      { decision: 'hold', count: 1 },
    ]);
    expect(formatSummary(summary)).toContain('2 would have been stopped');
  });

  it('says so plainly when nothing was held back', () => {
    expect(formatSummary(summarise([call(), result()]))).toContain('Nothing was held back');
  });

  it('keeps unscreened and failed apart, because they are different', () => {
    const summary = summarise([
      call({ screened: false }),
      call({ failure: { kind: 'unavailable' } }),
    ]);

    expect(summary.unscreened).toBe(1);
    expect(summary.failed).toBe(1);
    const text = formatSummary(summary);
    expect(text).toContain('no model asked');
    expect(text).toContain('attempted and failed');
  });

  it('adds up what it cost', () => {
    const summary = summarise([
      call({ requests: 1, input_tokens: 500, cost_usd: 0.0001 }),
      result({ requests: 2, input_tokens: 700, cost_usd: 0.0002 }),
    ]);

    expect(summary.requests).toBe(3);
    expect(summary.inputTokens).toBe(1_200);
    expect(summary.costUsd).toBeCloseTo(0.0003, 8);
  });

  it('breaks down by server when there is more than one', () => {
    const summary = summarise([call({ server: 'files' }), call({ server: 'github' })]);

    expect(summary.servers.map((one) => one.server).sort()).toEqual(['files', 'github']);
    expect(formatSummary(summary)).toContain('By server:');
  });

  it('counts tool lists that changed, and descriptions that read as steering', () => {
    const summary = summarise([
      {
        ts: '2026-05-05T09:00:00.000Z',
        id: 't1',
        kind: 'tool-list',
        server: 'files',
        mode: 'shadow',
        decision: 'changed',
        tools: 4,
        screened: true,
        changes: [{ kind: 'changed', name: 'read_file' }],
      } as AuditRecord,
      {
        ts: '2026-05-05T09:00:02.000Z',
        id: 't2',
        kind: 'tool-list',
        server: 'files',
        mode: 'shadow',
        decision: 'steering',
        tools: 4,
        screened: true,
        steering: [{ name: 'read_file', probability: 0.9 }],
      } as AuditRecord,
    ]);

    expect(summary.toolLists).toBe(2);
    expect(summary.toolListsChanged).toBe(1);
    expect(summary.steeringDescriptions).toBe(1);
  });

  it('reports the span the log covers', () => {
    const summary = summarise([
      call({ ts: '2026-05-05T09:00:00.000Z' }),
      call({ ts: '2026-05-06T10:00:00.000Z' }),
    ]);

    expect(summary.from).toBe('2026-05-05T09:00:00.000Z');
    expect(summary.to).toBe('2026-05-06T10:00:00.000Z');
  });
});

describe('deciding again with another policy', () => {
  const strict = parsePolicy('thresholds:\n  call:\n    hold_destructive: 0.1\n');
  const loose = parsePolicy('thresholds:\n  call:\n    hold_destructive: 0.99\n');

  const judged = call({
    id: 'a1',
    answers: { destructive: 0.5 },
    intended: { kind: 'forward' },
    applied: { kind: 'forward' },
  });

  it('finds a decision a lower threshold would change', () => {
    const outcome = replay([judged], strict);

    expect(outcome.replayed).toBe(1);
    expect(outcome.changes).toHaveLength(1);
    expect(outcome.changes[0]?.was).toBe('forward');
    expect(outcome.changes[0]?.now).toBe('hold');
    expect(outcome.stricter).toBe(1);
  });

  it('says plainly when a policy would change nothing', () => {
    const outcome = replay([judged], loose);

    expect(outcome.changes).toEqual([]);
    expect(formatReplay(outcome, 'other.yaml')).toContain('would not have changed anything');
  });

  it('skips judgments no model answered, since no threshold reaches them', () => {
    const outcome = replay([call({ screened: false, answers: { destructive: 0.99 } })], strict);

    expect(outcome.replayed).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(formatReplay(outcome, 'p.yaml')).toContain('no model answer');
  });

  it('ignores records that are not judgments', () => {
    const outcome = replay(
      [
        {
          ts: '2026-05-05T09:00:00.000Z',
          kind: 'eviction',
          server: 'files',
          id: '1',
          method: 'x',
          reason: 'count',
        } as AuditRecord,
      ],
      strict,
    );

    expect(outcome.replayed).toBe(0);
    expect(outcome.skipped).toBe(0);
  });

  it('tells stricter from looser', () => {
    const held = call({
      id: 'a2',
      answers: { destructive: 0.5 },
      intended: { kind: 'hold', reason: 'destructive', probability: 0.5 },
      applied: { kind: 'forward' },
    });
    const outcome = replay([held], loose);

    expect(outcome.looser).toBe(1);
    expect(outcome.stricter).toBe(0);
    expect(formatReplay(outcome, 'p.yaml')).toContain('1 looser');
  });

  it('names the ids, so each one can be read', () => {
    expect(formatReplay(replay([judged], strict), 'p.yaml')).toContain('a1');
  });
});
