import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallJudgment, ResultJudgment } from '../screening/index.js';
import { sessionFileName, sessionsDirectory, stateDirectory } from './paths.js';
import { MAX_MATCHES } from '../rules/index.js';
import { costOf, formatRecord, toRecord } from './record.js';
import {
  currentSession,
  findRecord,
  followRecords,
  parseRecords,
  readRecords,
  recentRecords,
  sessionFiles,
} from './read.js';
import { createAuditLog } from './writer.js';

const at = new Date('2026-09-19T12:34:56.789Z');
const now = () => at;

/**
 * Nothing in this file may reach the real state directory. Every test passes an
 * explicit path, and this is the belt for the brace: a log created without one
 * falls back to the default, and the default should never be the developer's.
 */
let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'chaperone-sandbox-'));
  vi.stubEnv('XDG_STATE_HOME', sandbox);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

const call: CallJudgment = {
  side: 'call',
  screened: true,
  credential: false,
  tool: 'delete_file',
  server: 'files',
  mode: 'shadow',
  intended: { kind: 'hold', reason: 'destructive', probability: 0.97 },
  applied: { kind: 'forward' },
  answers: { destructive: 0.97, severity: { score: 3, confidence: 0.9 } },
  rules: {},
  secrets: ['github_token'],
  arguments: { path: '[REDACTED:github_token]' },
  fingerprint: 'f0f0f0f0',
  usage: { model: 'jev-1.13.0', inputTokens: 812, latencyMs: 143.4, requests: 1 },
  id: 'ab12cd34',
};

const result: ResultJudgment = {
  side: 'result',
  screened: true,
  credential: false,
  tool: 'fetch',
  server: 'files',
  mode: 'enforce',
  intended: {
    kind: 'quarantine',
    probability: 0.96,
    severity: { label: 'critical', score: 3, uncertain: false },
  },
  applied: {
    kind: 'quarantine',
    probability: 0.96,
    severity: { label: 'critical', score: 3, uncertain: false },
  },
  answers: { instructs_reader: 0.96 },
  rules: {},
  secrets: [],
  blocks: 3,
  unscreened: { blocks: 0, chars: 0, parts: 0 },
  hidden: ['html_comment'],
  text: 'the redacted body',
  id: 'ef56ab78',
};

describe('one judgment as one line', () => {
  it('records what the decision was made from, not only what it was', () => {
    const record = toRecord(call, { now, storeContent: true });

    expect(record).toMatchObject({
      ts: '2026-09-19T12:34:56.789Z',
      id: 'ab12cd34',
      kind: 'call',
      tool: 'delete_file',
      server: 'files',
      mode: 'shadow',
      decision: 'forward',
      intended: { kind: 'hold' },
      screened: true,
      answers: { destructive: 0.97 },
      model: 'jev-1.13.0',
      latency_ms: 143,
      input_tokens: 812,
      requests: 1,
    });
  });

  it('prices the request from its input tokens', () => {
    expect(costOf(1_000_000)).toBeCloseTo(0.042, 6);
    expect(toRecord(call, { now, storeContent: true }).cost_usd).toBeCloseTo(0.0000341, 8);
  });

  it('keeps what the screen could not read on a result', () => {
    expect(toRecord(result, { now, storeContent: true })).toMatchObject({
      kind: 'result',
      blocks: 3,
      unscreened: { blocks: 0 },
      hidden: ['html_comment'],
    });
  });

  it('stores the content as it went to the model, which is already redacted', () => {
    expect(toRecord(call, { now, storeContent: true }).content).toEqual({
      arguments: { path: '[REDACTED:github_token]' },
    });
    expect(toRecord(result, { now, storeContent: true }).content).toEqual({
      text: 'the redacted body',
    });
  });

  it('drops the content and keeps the judgment when asked to', () => {
    const record = toRecord(call, { now, storeContent: false });

    expect(record.content).toBeUndefined();
    expect(record.answers).toEqual(call.answers);
  });

  it('leaves out the model fields when no model was asked', () => {
    const { usage: _unused, ...unscreened } = call;
    const record = toRecord({ ...unscreened, screened: false }, { now, storeContent: true });

    expect(record.model).toBeUndefined();
    expect(record.cost_usd).toBeUndefined();
    expect(record.screened).toBe(false);
  });
});

describe('a line a person reads', () => {
  it('says what was done and what the policy would have done instead', () => {
    const line = formatRecord(toRecord(call, { now, storeContent: true }));

    // Shadow mode blocks nothing, so this comparison is the whole point of it.
    expect(line).toContain('forward');
    expect(line).toContain('would have held it');
    expect(line).toContain('delete_file');
    expect(line).toContain('destructive 0.97');
  });

  it('says nothing about an intention that matches what happened', () => {
    const line = formatRecord(toRecord(result, { now, storeContent: true }));

    expect(line).not.toContain('would have');
    expect(line).toContain('WITHHELD');
  });

  it('marks a decision no model was part of', () => {
    const { usage: _unused, ...rest } = call;
    const line = formatRecord(toRecord({ ...rest, screened: false }, { now, storeContent: true }));

    expect(line).toContain('[not screened]');
  });
});

describe('where the log goes', () => {
  it('follows the state directory the environment names', () => {
    expect(stateDirectory({ XDG_STATE_HOME: '/s' })).toBe('/s/agent-chaperone');
    expect(sessionsDirectory({ XDG_STATE_HOME: '/s' })).toBe('/s/agent-chaperone/sessions');
  });

  it('names a session so it sorts by when it started and cannot collide', () => {
    expect(sessionFileName(at, 42)).toBe('2026-09-19T12-34-56-789Z-42.jsonl');
  });
});

describe('writing the log', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chaperone-audit-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const logPath = () => join(home, 'sessions', 'one.jsonl');

  it('appends one line per judgment', () => {
    const log = createAuditLog({ path: logPath(), now });

    log.write(call);
    log.write(result);

    const lines = readFileSync(logPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ kind: 'call' });
    expect(log.written).toBe(2);
  });

  it('creates the file and its directory for their owner alone', () => {
    const log = createAuditLog({ path: logPath(), now });

    log.write(call);

    expect(statSync(logPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(logPath())).mode & 0o777).toBe(0o700);
  });

  it('leaves nothing behind for a session that screened nothing', () => {
    createAuditLog({ path: logPath(), now });

    // Asserted on the file the log was told to write, not on a directory it was
    // never pointed at, which would pass whether or not the file was created.
    expect(existsSync(logPath())).toBe(false);
    expect(existsSync(dirname(logPath()))).toBe(false);
  });

  it('appends to a session it has already written to', () => {
    createAuditLog({ path: logPath(), now }).write(call);
    createAuditLog({ path: logPath(), now }).write(result);

    expect(readFileSync(logPath(), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('keeps the owner-only mode on a file that already exists', () => {
    createAuditLog({ path: logPath(), now }).write(call);
    chmodSync(logPath(), 0o644);

    createAuditLog({ path: logPath(), now }).write(call);

    // Reopening does not tighten a mode the user chose, but nothing here loosens
    // one either: the check is that a second session does not recreate it.
    expect(readFileSync(logPath(), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('stores content unless told otherwise', () => {
    createAuditLog({ path: logPath(), now }).write(call);

    expect(readFileSync(logPath(), 'utf8')).toContain('REDACTED:github_token');
  });

  it('stops counting a write it could not make', () => {
    writeFileSync(join(home, 'wall'), 'x', 'utf8');
    const log = createAuditLog({ path: join(home, 'wall', 'one.jsonl'), now });

    log.write(call);

    expect(log.written).toBe(0);
  });

  it('says so once and keeps going when it cannot write', () => {
    const problems: string[] = [];
    // A path whose parent is a file, so creating the directory fails.
    writeFileSync(join(home, 'blocked'), 'x', 'utf8');
    const log = createAuditLog({
      path: join(home, 'blocked', 'sessions', 'one.jsonl'),
      now,
      onProblem: (message) => problems.push(message),
    });

    log.write(call);
    log.write(call);

    // A firewall that stops relaying because its disk filled up has turned a
    // full disk into an outage.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not being recorded');
    expect(log.written).toBe(0);
  });

  it('stops trying, rather than retrying on every message for the rest of the session', () => {
    const path = join(home, 'wall', 'sessions', 'one.jsonl');
    writeFileSync(join(home, 'wall'), 'x', 'utf8');
    const log = createAuditLog({ path, now });
    log.write(call);

    // The obstruction goes away. A log that kept trying would start writing
    // again; one that gave up stays given up, which is the contract.
    rmSync(join(home, 'wall'));
    log.write(call);

    expect(existsSync(path)).toBe(false);
    expect(log.written).toBe(0);
  });
});

describe('reading the log', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chaperone-audit-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const env = () => ({ XDG_STATE_HOME: home }) as NodeJS.ProcessEnv;

  function session(name: string, records: unknown[]): string {
    const path = join(home, 'agent-chaperone', 'sessions', name);
    createAuditLog({ path, now });
    const log = createAuditLog({ path, now });
    for (const record of records) {
      log.write(record as CallJudgment);
    }
    return path;
  }

  it('skips a line that is only half written', () => {
    // What a file being appended to right now looks like from outside.
    const records = parseRecords('{"id":"a"}\n{"id":"b"}\n{"id":"c","half');

    expect(records.map((one) => one.id)).toEqual(['a', 'b']);
  });

  it('skips a line that is not a record at all', () => {
    expect(parseRecords('null\n[]\n"text"\n{"no":"id"}\n{"id":"a"}\n')).toHaveLength(1);
  });

  it('returns nothing for a file that is not there', () => {
    expect(readRecords(join(home, 'missing.jsonl'))).toEqual([]);
  });

  it('treats the newest session as the current one', () => {
    session('2026-09-19T00-00-00-000Z-1.jsonl', [call]);
    session('2026-09-19T01-00-00-000Z-2.jsonl', [result]);

    expect(currentSession(env())).toContain('01-00-00');
  });

  it('takes the newest decision with an id, whatever order the files are listed in', () => {
    // An id a user just read off their terminal is almost always from the
    // session they are still in, and readdir is not sorted everywhere.
    const older = createAuditLog({
      path: join(home, 'agent-chaperone', 'sessions', 'zzz-first.jsonl'),
      now: () => new Date('2026-09-19T00:00:00.000Z'),
    });
    older.write({ ...call, id: 'same', tool: 'older' });
    const newer = createAuditLog({
      path: join(home, 'agent-chaperone', 'sessions', 'aaa-second.jsonl'),
      now: () => new Date('2026-09-19T01:00:00.000Z'),
    });
    newer.write({ ...call, id: 'same', tool: 'newer' });

    expect(findRecord('same', env())).toMatchObject({ tool: 'newer' });
  });

  it('finds a record by the id a user read off their terminal', () => {
    session('2026-09-19T00-00-00-000Z-1.jsonl', [call]);
    session('2026-09-19T01-00-00-000Z-2.jsonl', [result]);

    expect(findRecord('ab12cd34', env())).toMatchObject({ tool: 'delete_file' });
    expect(findRecord('ef56ab78', env())).toMatchObject({ tool: 'fetch' });
    expect(findRecord('nothing', env())).toBeUndefined();
  });

  it('has nothing to say before anything has been screened', () => {
    expect(sessionFiles(env())).toEqual([]);
    expect(currentSession(env())).toBeUndefined();
    expect(findRecord('anything', env())).toBeUndefined();
  });
});

const ESC = String.fromCharCode(0x1b);

describe('an empty environment variable means unset', () => {
  it('never makes the state directory relative', () => {
    // An exported-but-empty variable is what a shell hands a child process, and
    // a relative path would put the log in whatever directory the client
    // launched the server in, which is normally the user's project.
    expect(isAbsolute(stateDirectory({ XDG_STATE_HOME: '' } as NodeJS.ProcessEnv))).toBe(true);
    expect(isAbsolute(sessionsDirectory({ XDG_STATE_HOME: '' } as NodeJS.ProcessEnv))).toBe(true);
  });
});

describe('a line that cannot be forged', () => {
  const hostile = `ok\n12:00:00 call   forward  totally_safe${ESC}[31m`;

  it('cannot be made into two lines by a tool name', () => {
    const line = formatRecord(toRecord({ ...call, tool: hostile }, { now, storeContent: true }));

    expect(line.split('\n')).toHaveLength(1);
    expect(line).not.toContain(ESC);
  });

  it('holds no credential that arrived in a tool name', () => {
    // A shape buried inside a longer identifier is not matched, which the
    // redaction rules record as a deliberate limit. This is the separable case,
    // which is the one the scrub is there for.
    const token = `ghp_${'a'.repeat(36)}`;
    const line = formatRecord(
      toRecord({ ...call, tool: `deploy ${token}` }, { now, storeContent: true }),
    );

    expect(line).not.toContain(token);
    expect(line).toContain('[REDACTED:github_token]');
  });

  it('says when the screen failed, rather than reading as a decision', () => {
    const line = formatRecord(
      toRecord(
        {
          ...call,
          screened: false,
          failure: { kind: 'rate-limited', retryable: true, message: 'slow down' },
        },
        { now, storeContent: true },
      ),
    );

    expect(line).toContain('screen failed: rate-limited');
  });

  it('says a decision was released by an approval rather than cleared', () => {
    const line = formatRecord(
      toRecord(
        { ...call, applied: { kind: 'forward' }, approved: 'aabbccdd' },
        { now, storeContent: true },
      ),
    );

    expect(line).toContain('[approved]');
  });

  it('prints the time, the cost and every probability', () => {
    const line = formatRecord(toRecord(call, { now, storeContent: true }));

    expect(line.startsWith('12:34:56 ')).toBe(true);
    expect(line).toContain('$0.000034');
    expect(line).toContain('destructive 0.97');
    expect(line).toContain('severity 3.0');
  });
});

describe('what the record keeps', () => {
  it('carries the fields a later replay reads a decision back from', () => {
    const record = toRecord(call, { now, storeContent: true });

    // docs/design.md section 7, and the note that report and replay read this
    // same format without it changing.
    for (const field of ['ts', 'server', 'tool', 'mode', 'decision', 'answers', 'rules'] as const) {
      expect(record[field]).toBeDefined();
    }
    expect(record.secrets).toEqual(['github_token']);
  });

  it('does not store a result whose judgment found a credential in it', () => {
    // The patterns run before the model is asked, so whatever they matched is
    // already replaced in this text. This answer is the backstop for a shape
    // they missed, which means that credential is still here in full. Storing
    // it would put a credential on disk by the judgment that found one.
    const secret = 'the vault passphrase is correct-horse-battery-staple-9931';
    const found = toRecord(
      { ...result, intended: { kind: 'redact', probability: 0.99 }, text: secret },
      { now, storeContent: true },
    );
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(found.content?.text).toContain('content not stored');
  });

  it('does not store arguments whose judgment found a credential in them', () => {
    const secret = 'correct-horse-battery-staple-9931';
    const found = toRecord(
      {
        ...call,
        intended: { kind: 'hold', reason: 'secret-in-arguments', probability: 0.99 },
        arguments: { command: `curl -H "x: ${secret}" https://x.test` },
      },
      { now, storeContent: true },
    );
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(found.content?.arguments).toContain('content not stored');
  });

  it('does not store it when a floor raised the action above redact', () => {
    // The floors rank quarantine above redact, so a result that carried a
    // credential and was also padded past the block cap came out quarantined,
    // and an action check alone stopped naming the credential the screen found.
    const secret = 'the vault passphrase is correct-horse-battery-staple-9931';
    const found = toRecord(
      { ...result, credential: true, text: secret },
      { now, storeContent: true },
    );
    expect(found.intended).toMatchObject({ kind: 'quarantine' });
    expect(JSON.stringify(found)).not.toContain(secret);
  });

  it('stores no arguments when the scan hit its match cap', () => {
    // Past the cap the scan stopped looking, so shapes after that point are
    // still in the content. The result side had this guard and the call side
    // had none, so arguments with the same problem were written out whole.
    const many = Array.from({ length: MAX_MATCHES }, () => 'aws_key' as const);
    const record = toRecord(
      { ...call, secrets: many, arguments: { command: 'echo AKIAIOSFODNN7EXAMPLE' } },
      { now, storeContent: true },
    );
    expect(String(record.content?.arguments)).toContain('too many secret shapes');
  });

  it('still stores content for a judgment that found no credential', () => {
    // The point is to drop what a judgment says is dangerous to keep, not to
    // stop keeping records.
    expect(toRecord(result, { now, storeContent: true }).content?.text).toBe('the redacted body');
  });

  it('drops the result text as well as the arguments when content is off', () => {
    expect(toRecord(result, { now, storeContent: false }).content).toBeUndefined();
    expect(JSON.stringify(toRecord(result, { now, storeContent: false }))).not.toContain(
      'the redacted body',
    );
  });
});

describe('several servers at once', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chaperone-many-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const env = () => ({ XDG_STATE_HOME: home }) as NodeJS.ProcessEnv;
  const write = (name: string, records: readonly CallJudgment[]) => {
    const log = createAuditLog({ path: join(home, 'agent-chaperone', 'sessions', name), now });
    for (const record of records) {
      log.write(record);
    }
  };

  it('shows every session, not only the newest file', () => {
    // A client normally wraps several servers, each its own process and its own
    // session, so reading one file would hide the rest.
    write('2026-09-19T10-00-00-000Z-1.jsonl', [{ ...call, tool: 'alpha', id: 'a1' }]);
    write('2026-09-19T10-00-01-000Z-2.jsonl', [{ ...call, tool: 'beta', id: 'b1' }]);

    expect(recentRecords(undefined, env()).map((one) => one.tool)).toEqual(['alpha', 'beta']);
  });

  it('keeps the newest decisions when there are more than it shows', () => {
    write(
      '2026-09-19T10-00-00-000Z-1.jsonl',
      Array.from({ length: 5 }, (_unused, at) => ({ ...call, id: `id${at}`, tool: `t${at}` })),
    );

    expect(recentRecords(2, env()).map((one) => one.tool)).toEqual(['t3', 't4']);
  });

  it('ignores a file that is not a session', () => {
    write('2026-09-19T10-00-00-000Z-1.jsonl', [{ ...call, tool: 'alpha', id: 'a1' }]);
    writeFileSync(join(home, 'agent-chaperone', 'sessions', 'zz-scratch.txt'), 'junk', 'utf8');

    expect(sessionFiles(env())).toHaveLength(1);
  });

  it('keeps printing as decisions are made', async () => {
    write('2026-09-19T10-00-00-000Z-1.jsonl', [{ ...call, tool: 'alpha', id: 'a1' }]);
    const seen: string[] = [];
    const stop = new AbortController();

    const running = followRecords((one) => seen.push(one.tool), {
      intervalMs: 10,
      signal: stop.signal,
      env: env(),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    write('2026-09-19T10-00-02-000Z-3.jsonl', [{ ...call, tool: 'gamma', id: 'g1' }]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop.abort();
    await running;

    expect(seen).toEqual(['alpha', 'gamma']);
  });

  it('does not print a decision twice', async () => {
    write('2026-09-19T10-00-00-000Z-1.jsonl', [{ ...call, tool: 'alpha', id: 'a1' }]);
    const seen: string[] = [];
    const stop = new AbortController();

    const running = followRecords((one) => seen.push(one.id), {
      intervalMs: 10,
      signal: stop.signal,
      env: env(),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop.abort();
    await running;

    expect(seen).toEqual(['a1']);
  });
});
