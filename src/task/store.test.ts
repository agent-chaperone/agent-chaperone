import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TTL_MS,
  MAX_TASK_CHARS,
  clearTask,
  readTask,
  taskFileName,
  writeTask,
} from './index.js';

const AT = new Date('2026-05-05T09:00:00.000Z');
const later = (ms: number) => () => new Date(AT.getTime() + ms);

describe('what the agent was asked to do', () => {
  let state: string;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'chaperone-task-'));
    vi.stubEnv('XDG_STATE_HOME', state);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(state, { recursive: true, force: true });
  });

  it('reads back what was written', () => {
    writeTask('/work/repo', 'fix the login redirect', () => AT);

    expect(readTask('/work/repo', () => AT)?.text).toBe('fix the login redirect');
  });

  it('is nothing when none was set', () => {
    expect(readTask('/work/repo', () => AT)).toBeUndefined();
  });

  it('belongs to one directory, not to the machine', () => {
    writeTask('/work/repo-a', 'task for a', () => AT);

    expect(readTask('/work/repo-b', () => AT)).toBeUndefined();
    expect(readTask('/work/repo-a', () => AT)?.text).toBe('task for a');
  });

  it('stops being believed once it expires', () => {
    writeTask('/work/repo', 'yesterday', () => AT);

    expect(readTask('/work/repo', later(DEFAULT_TTL_MS - 1_000))?.text).toBe('yesterday');
    // A stale task would have the screen judging today's calls against intent
    // the user has moved on from, which is worse than having none.
    expect(readTask('/work/repo', later(DEFAULT_TTL_MS + 1_000))).toBeUndefined();
  });

  it('replaces the previous one rather than keeping both', () => {
    writeTask('/work/repo', 'first', () => AT);
    writeTask('/work/repo', 'second', () => AT);

    expect(readTask('/work/repo', () => AT)?.text).toBe('second');
  });

  it('bounds the text, since it is sent with every screened call', () => {
    writeTask('/work/repo', 'x'.repeat(MAX_TASK_CHARS * 3), () => AT);

    expect(readTask('/work/repo', () => AT)?.text.length).toBe(MAX_TASK_CHARS);
  });

  it('clears, and says whether there was anything to clear', () => {
    writeTask('/work/repo', 'something', () => AT);

    expect(clearTask('/work/repo')).toBe(true);
    expect(readTask('/work/repo', () => AT)).toBeUndefined();
    expect(clearTask('/work/repo')).toBe(false);
  });

  it('keeps it to the user, since it says what they are working on', () => {
    writeTask('/work/repo', 'something private', () => AT);
    const path = join(state, 'agent-chaperone', 'tasks', taskFileName('/work/repo'));

    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('does not put the directory in the file name', () => {
    const name = taskFileName('/Users/someone/repos/secret-project');

    expect(name).not.toContain('secret-project');
    expect(name).not.toContain('/');
  });

  it('is undefined rather than throwing on a file that is not a task', () => {
    writeTask('/work/repo', 'real', () => AT);
    const path = join(state, 'agent-chaperone', 'tasks', taskFileName('/work/repo'));
    rmSync(path);

    expect(readTask('/work/repo', () => AT)).toBeUndefined();
  });
});
