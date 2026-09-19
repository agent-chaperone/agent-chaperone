import { describe, expect, it } from 'vitest';
import { MAX_PAGES, MAX_TOOLS, ToolListAssembly } from './listing.js';

const tool = (name: string) => ({ name, description: `does ${name}`, inputSchema: {} });
const first = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const next = (cursor: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: { cursor },
});
const page = (names: string[], cursor?: string) => ({
  tools: names.map(tool),
  ...(cursor === undefined ? {} : { nextCursor: cursor }),
});

describe('putting a listing back together', () => {
  it('hands back a single-page listing at once', () => {
    const a = new ToolListAssembly();
    const done = a.add(first, page(['read_file']));

    expect(done.kind).toBe('complete');
    expect(done.kind === 'complete' && done.tools.map((t) => t.name)).toEqual(['read_file']);
  });

  it('waits for the page that has no cursor', () => {
    const a = new ToolListAssembly();

    expect(a.add(first, page(['a', 'b'], 'more')).kind).toBe('incomplete');
    const done = a.add(next('more'), page(['c', 'd']));

    expect(done.kind).toBe('complete');
    expect(done.kind === 'complete' && done.tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('joins many pages in the order they arrived', () => {
    const a = new ToolListAssembly();
    a.add(first, page(['a'], 'c1'));
    a.add(next('c1'), page(['b'], 'c2'));
    a.add(next('c2'), page(['c'], 'c3'));
    const done = a.add(next('c3'), page(['d']));

    expect(done.kind === 'complete' && done.tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts over when a request carries no cursor, so a second listing replaces the first', () => {
    const a = new ToolListAssembly();
    a.add(first, page(['stale'], 'more'));
    const done = a.add(first, page(['fresh']));

    expect(done.kind === 'complete' && done.tools.map((t) => t.name)).toEqual(['fresh']);
  });

  it('is reusable, so the next listing does not inherit the last one', () => {
    const a = new ToolListAssembly();
    a.add(first, page(['a'], 'more'));
    a.add(next('more'), page(['b']));
    const second = a.add(first, page(['a'], 'more'));
    const done = a.add(next('more'), page(['b']));

    expect(second.kind).toBe('incomplete');
    expect(done.kind === 'complete' && done.tools.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('abandons a listing that never ends rather than holding it forever', () => {
    const a = new ToolListAssembly();
    a.add(first, page(['t0'], 'c'));
    let last = a.add(next('c'), page(['t1'], 'c'));
    for (let at = 2; at <= MAX_PAGES + 1; at += 1) {
      last = a.add(next('c'), page([`t${at}`], 'c'));
    }

    expect(last.kind).toBe('abandoned');
    expect(last.kind === 'abandoned' && last.reason).toBe('pages');
  });

  it('reports an abandoned listing once, not once per remaining page', () => {
    const a = new ToolListAssembly();
    a.add(first, page(['t0'], 'c'));
    for (let at = 1; at <= MAX_PAGES + 1; at += 1) {
      a.add(next('c'), page([`t${at}`], 'c'));
    }
    const after = a.add(next('c'), page(['more'], 'c'));

    // Still abandoned rather than starting a fresh count, because the cursor
    // says this continues the listing that was already given up on.
    expect(after.kind).toBe('abandoned');
  });

  it('lets a fresh listing recover after one was abandoned', () => {
    const a = new ToolListAssembly();
    a.add(first, page(['t0'], 'c'));
    for (let at = 1; at <= MAX_PAGES + 1; at += 1) {
      a.add(next('c'), page([`t${at}`], 'c'));
    }
    const fresh = a.add(first, page(['read_file']));

    expect(fresh.kind).toBe('complete');
  });

  it('abandons a listing carrying more tools than anyone reviews', () => {
    const a = new ToolListAssembly();
    const many = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => `t${i}`);
    const done = a.add(first, page(many));

    expect(done.kind).toBe('abandoned');
    expect(done.kind === 'abandoned' && done.reason).toBe('tools');
  });

  it('treats a result that is not a tool list as an empty page', () => {
    const a = new ToolListAssembly();
    for (const junk of [null, 42, 'tools', {}, { tools: 'read_file' }]) {
      expect(a.add(first, junk).kind).toBe('complete');
    }
  });

  it('does not mistake a request it cannot read for a continuation', () => {
    const a = new ToolListAssembly();
    a.add(first, page(['stale'], 'more'));
    // No request at all, which is what an uncorrelated response looks like.
    const done = a.add(undefined, page(['fresh']));

    expect(done.kind === 'complete' && done.tools.map((t) => t.name)).toEqual(['fresh']);
  });
});
