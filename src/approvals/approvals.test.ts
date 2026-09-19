import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TTL_MS,
  HOLD_TTL_MS,
  approvalsDirectory,
  callFingerprint,
  grantApproval,
  holdsDirectory,
  readHold,
  recordHold,
  sweepApprovals,
  takeApproval,
} from './approvals.js';

const at = new Date('2026-09-19T12:00:00.000Z');
const now = () => at;

describe('what an approval is for', () => {
  it('names one call, not a tool', () => {
    const one = callFingerprint('files', 'write_file', { path: 'a.txt' });
    const two = callFingerprint('files', 'write_file', { path: 'b.txt' });

    // Agreeing to a write to one path is not agreeing to a write to another.
    expect(one).not.toBe(two);
  });

  it('is the same call however the arguments were ordered', () => {
    expect(callFingerprint('files', 'write', { a: 1, b: 2 })).toBe(
      callFingerprint('files', 'write', { b: 2, a: 1 }),
    );
  });

  it('separates the same call on two servers', () => {
    expect(callFingerprint('files', 'write', {})).not.toBe(callFingerprint('other', 'write', {}));
  });

  it('does not throw on anything a caller can put in the arguments', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(() => callFingerprint('files', 'write', cyclic)).not.toThrow();
    expect(() => callFingerprint('files', 'write', { n: 1n })).not.toThrow();
  });
});

describe('granting and spending one', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chaperone-approve-'));
    env = { XDG_STATE_HOME: home } as NodeJS.ProcessEnv;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const print = callFingerprint('files', 'delete_file', { path: 'a.txt' });
  const hold = (id: string, tool: string, fingerprint: string) => ({
    id,
    server: 'files',
    tool,
    fingerprint,
    heldAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + HOLD_TTL_MS).toISOString(),
  });

  it('releases the call it was granted for', () => {
    grantApproval(hold('ab12', 'delete_file', print), { now, env });

    expect(takeApproval(print, { now, env })).toMatchObject({ id: 'ab12', tool: 'delete_file' });
  });

  it('releases it once and no more', () => {
    grantApproval(hold('ab12', 'delete_file', print), { now, env });

    expect(takeApproval(print, { now, env })).toBeDefined();
    // The retry goes through and the one after it is held again, which is what
    // the user agreed to.
    expect(takeApproval(print, { now, env })).toBeUndefined();
  });

  it('releases nothing for a different call', () => {
    grantApproval(hold('ab12', 'delete_file', print), { now, env });

    expect(
      takeApproval(callFingerprint('files', 'delete_file', { path: 'b.txt' }), { now, env }),
    ).toBeUndefined();
  });

  it('has nothing to give when none was granted', () => {
    expect(takeApproval(print, { now, env })).toBeUndefined();
  });

  it('expires, and spends itself doing so', () => {
    grantApproval(hold('ab12', 'delete_file', print), { now, env, ttlMs: 1000 });
    const later = () => new Date(at.getTime() + 2000);

    expect(takeApproval(print, { now: later, env })).toBeUndefined();
    // Gone either way: a token that survived being refused would sit there until
    // someone's clock agreed with it.
    expect(takeApproval(print, { now, env })).toBeUndefined();
  });

  it('lasts long enough to read a message and type a command', () => {
    expect(DEFAULT_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('is written for its owner alone', () => {
    grantApproval(hold('ab12', 'delete_file', print), { now, env });

    expect(statSync(join(approvalsDirectory(env), `${print}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(approvalsDirectory(env)).mode & 0o777).toBe(0o700);
  });

  it('ignores a token nobody could have written', () => {
    grantApproval(hold('ab12', 'delete_file', print), { now, env });
    writeFileSync(join(approvalsDirectory(env), `${print}.json`), 'not json', 'utf8');

    expect(takeApproval(print, { now, env })).toBeUndefined();
  });

  it('clears out tokens nobody spent', () => {
    grantApproval(hold('old', 'a', callFingerprint('files', 'a', {})), { now, env, ttlMs: 1000 });
    grantApproval(hold('new', 'b', callFingerprint('files', 'b', {})), { now, env });

    const removed = sweepApprovals({ now: () => new Date(at.getTime() + 2000), env });

    expect(removed).toBe(1);
    expect(takeApproval(callFingerprint('files', 'b', {}), { now, env })).toBeDefined();
  });

  it('sweeps nothing when nothing has been granted', () => {
    expect(sweepApprovals({ now, env })).toBe(0);
  });
});

describe('what a held id stands for', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chaperone-hold-'));
    env = { XDG_STATE_HOME: home } as NodeJS.ProcessEnv;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const print = callFingerprint('files', 'delete_file', { path: 'a.txt' });

  it('remembers the call, so approving needs no audit log at all', () => {
    recordHold('abcd1234', 'files', 'delete_file', print, { now, env });

    expect(readHold('abcd1234', { now, env })).toMatchObject({
      server: 'files',
      tool: 'delete_file',
      fingerprint: print,
    });
  });

  it('is written for its owner alone', () => {
    recordHold('abcd1234', 'files', 'delete_file', print, { now, env });

    expect(statSync(join(holdsDirectory(env), 'abcd1234.json')).mode & 0o777).toBe(0o600);
    expect(statSync(holdsDirectory(env)).mode & 0o777).toBe(0o700);
  });

  it('stops meaning anything after a day', () => {
    recordHold('abcd1234', 'files', 'delete_file', print, { now, env });
    const tomorrow = () => new Date(at.getTime() + HOLD_TTL_MS + 1000);

    expect(readHold('abcd1234', { now: tomorrow, env })).toBeUndefined();
    expect(HOLD_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it.each([['../../etc/passwd'], ['a/b'], [''], ['not-hex'], ['AB12']])(
    'refuses %o as an id rather than writing where it points',
    (id) => {
      expect(recordHold(id, 'files', 'x', print, { now, env })).toBeUndefined();
      expect(readHold(id, { now, env })).toBeUndefined();
    },
  );

  it('refuses a fingerprint that is not one', () => {
    expect(
      grantApproval(
        {
          id: 'abcd1234',
          server: 'files',
          tool: 'x',
          fingerprint: '../escape',
          heldAt: '',
          expiresAt: '',
        },
        { now, env },
      ),
    ).toBeUndefined();
    expect(takeApproval('../escape', { now, env })).toBeUndefined();
  });
});

describe('two processes reaching one token', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chaperone-race-'));
    env = { XDG_STATE_HOME: home } as NodeJS.ProcessEnv;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const print = callFingerprint('files', 'delete_file', { path: 'a.txt' });
  const hold = {
    id: 'abcd1234',
    server: 'files',
    tool: 'delete_file',
    fingerprint: print,
    heldAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + HOLD_TTL_MS).toISOString(),
  };

  it('claims it before reading it, so only one of them spends it', () => {
    grantApproval(hold, { now, env });

    // A client normally runs several of these at once. Reading and then deleting
    // is two syscalls with a gap, and both would have come back with a token.
    const results = [takeApproval(print, { now, env }), takeApproval(print, { now, env })];

    expect(results.filter((one) => one !== undefined)).toHaveLength(1);
  });

  it('refuses a token filed under a fingerprint it does not claim itself', () => {
    grantApproval({ ...hold, fingerprint: callFingerprint('files', 'other', {}) }, { now, env });
    // Filed where the gate would look for a different call.
    writeFileSync(
      join(approvalsDirectory(env), `${print}.json`),
      `${JSON.stringify({ ...hold, fingerprint: 'deadbeefdeadbeef', grantedAt: at.toISOString(), expiresAt: new Date(at.getTime() + 60_000).toISOString() })}\n`,
      'utf8',
    );

    expect(takeApproval(print, { now, env })).toBeUndefined();
  });

  it('leaves nothing behind when it refuses one', () => {
    grantApproval(hold, { now, env, ttlMs: 1000 });

    takeApproval(print, { now: () => new Date(at.getTime() + 5000), env });

    expect(existsSync(join(approvalsDirectory(env), `${print}.json`))).toBe(false);
    expect(readdirSync(approvalsDirectory(env))).toEqual([]);
  });

  it('clears a claim left by a process that died holding one', () => {
    grantApproval(hold, { now, env });
    writeFileSync(join(approvalsDirectory(env), `${print}.json.999.claim`), '{}', 'utf8');

    const removed = sweepApprovals({ now, env });

    expect(removed).toBe(1);
    expect(takeApproval(print, { now, env })).toBeDefined();
  });

  it('sweeps holds nobody returned to, as well as tokens', () => {
    recordHold('abcd1234', 'files', 'x', print, { now, env, ttlMs: 1000 });

    expect(sweepApprovals({ now: () => new Date(at.getTime() + 5000), env })).toBe(1);
    expect(readHold('abcd1234', { now, env })).toBeUndefined();
  });

  it.each([
    ['no expiry', { id: 'a', tool: 'x', fingerprint: 'deadbeefdeadbeef', grantedAt: 'x' }],
    ['an expiry that is not a string', { id: 'a', tool: 'x', fingerprint: 'x', expiresAt: 99 }],
    ['an array', ['not', 'a', 'token']],
  ])('refuses a token with %s, and sweeps it', (_name, body) => {
    const path = join(approvalsDirectory(env), `${print}.json`);
    grantApproval(hold, { now, env });
    writeFileSync(path, `${JSON.stringify(body)}\n`, 'utf8');

    expect(takeApproval(print, { now, env })).toBeUndefined();
    grantApproval(hold, { now, env });
    writeFileSync(path, `${JSON.stringify(body)}\n`, 'utf8');
    // A token with no readable expiry must not become one that never expires.
    expect(sweepApprovals({ now, env })).toBe(1);
  });
});
