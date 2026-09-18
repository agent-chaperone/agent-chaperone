import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readLines } from '../proxy/__fixtures__/streams.js';
import { isEntryPoint, parseArguments, run } from './main.js';

describe('parseArguments', () => {
  it('takes everything after the separator as the upstream command', () => {
    expect(parseArguments(['--', 'npx', '-y', 'some-server', '.'])).toEqual({
      command: 'npx',
      args: ['-y', 'some-server', '.'],
    });
  });

  it('accepts a bare command with no separator', () => {
    expect(parseArguments(['node', 'server.js'])).toEqual({
      command: 'node',
      args: ['server.js'],
    });
  });

  it('accepts a command that takes no arguments', () => {
    expect(parseArguments(['--', 'my-server'])).toEqual({ command: 'my-server', args: [] });
  });

  it('returns nothing when no command is given', () => {
    expect(parseArguments([])).toBeUndefined();
    expect(parseArguments(['--'])).toBeUndefined();
  });

  it('refuses a leading flag, which is a mistyped invocation rather than a command', () => {
    expect(parseArguments(['--help'])).toBeUndefined();
    expect(parseArguments(['-v'])).toBeUndefined();
  });

  it('keeps flags that belong to the upstream command', () => {
    expect(parseArguments(['--', 'server', '--port', '8080'])?.args).toEqual(['--port', '8080']);
  });
});

describe('isEntryPoint', () => {
  it('recognises this module when it is the program being run', () => {
    const here = fileURLToPath(import.meta.url).replace(/\.test\.ts$/, '.ts');
    expect(isEntryPoint(here, new URL('./main.ts', import.meta.url).href)).toBe(true);
  });

  it('is false when another file is the program being run', () => {
    expect(
      isEntryPoint(fileURLToPath(import.meta.url), new URL('./main.ts', import.meta.url).href),
    ).toBe(false);
  });

  it('is false when there is no program path at all', () => {
    expect(isEntryPoint(undefined, import.meta.url)).toBe(false);
  });

  it('is false rather than throwing when the path does not exist', () => {
    expect(isEntryPoint('/definitely/not/here.js', import.meta.url)).toBe(false);
  });
});

describe('run', () => {
  const FIXTURE = fileURLToPath(
    new URL('../proxy/__fixtures__/echo-upstream.mjs', import.meta.url),
  );

  function io() {
    return { input: new PassThrough(), output: new PassThrough(), errorOutput: new PassThrough() };
  }

  it('spawns the upstream, relays a call, and returns the upstream exit code', async () => {
    const streams = io();
    const exit = run(['--', process.execPath, FIXTURE], streams);
    streams.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
    const [reply] = await readLines(streams.output, 1);
    expect(JSON.parse(reply ?? '{}').result.echoedMethod).toBe('tools/list');
    streams.input.end();
    await expect(exit).resolves.toBe(0);
  });

  it('returns the upstream exit code when the server dies', async () => {
    const streams = io();
    const exit = run(['--', process.execPath, FIXTURE], streams);
    streams.input.write('{"jsonrpc":"2.0","id":1,"method":"test/crash"}\n');
    await expect(exit).resolves.toBe(3);
  });

  it('prints usage and returns a usage code when no command is given', async () => {
    const streams = io();
    await expect(run([], streams)).resolves.toBe(64);
    expect(streams.errorOutput.read()?.toString()).toContain('agent-chaperone --');
  });

  it('explains a command it cannot start, without a stack trace', async () => {
    const streams = io();
    await expect(run(['--', 'agent-chaperone-no-such-command'], streams)).resolves.toBe(127);
    const written = streams.errorOutput.read()?.toString() ?? '';
    expect(written).toContain('command not found');
    expect(written).not.toContain('    at ');
  });

  it('stops waiting for a server that ignores the end of its input', async () => {
    const streams = io();
    // node -e with an open handle never exits on stdin EOF.
    const exit = run(['--', process.execPath, '-e', 'setInterval(() => {}, 1000)'], streams, {
      graceMs: 150,
    });
    streams.input.end();
    await expect(exit).resolves.toBeTypeOf('number');
  }, 10000);
});
