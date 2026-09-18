import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // No test may reach the network. A developer with a key exported would
  // otherwise have the CLI build a real backend and screen against the live API.
  beforeEach(() => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const FIXTURE = fileURLToPath(
    new URL('../proxy/__fixtures__/echo-upstream.mjs', import.meta.url),
  );

  function io() {
    const errorOutput = new PassThrough();
    // Collected as it arrives. `read()` hands back one chunk at a time, so a
    // single call sees only whichever line happened to be written first.
    const errors: string[] = [];
    errorOutput.on('data', (chunk: Buffer) => errors.push(chunk.toString()));
    return {
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput,
      stderr: () => errors.join(''),
    };
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
    expect(streams.stderr()).toContain('agent-chaperone [options] --');
  });

  it('explains a command it cannot start, without a stack trace', async () => {
    const streams = io();
    await expect(run(['--', 'agent-chaperone-no-such-command'], streams)).resolves.toBe(127);
    const written = streams.stderr();
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

  describe('screening a real session', () => {
    const FIXTURE = fileURLToPath(
      new URL('../proxy/__fixtures__/echo-upstream.mjs', import.meta.url),
    );

    function policyFile(contents: string): string {
      const directory = mkdtempSync(join(tmpdir(), 'chaperone-'));
      const path = join(directory, 'policy.yaml');
      writeFileSync(path, contents, 'utf8');
      return path;
    }

    it('blocks a denied tool without the upstream ever seeing it', async () => {
      const path = policyFile('mode: enforce\nservers:\n  node:\n    deny_tools: ["delete_*"]\n');
      const streams = io();
      const exit = run(
        ['--policy', path, '--server', 'node', '--', process.execPath, FIXTURE],
        streams,
      );

      streams.input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_file', arguments: { path: 'a' } } })}\n`,
      );
      const [reply] = await readLines(streams.output, 1);
      const parsed = JSON.parse(reply ?? '{}') as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };

      expect(parsed.result?.isError).toBe(true);
      expect(parsed.result?.content?.[0]?.text).toContain('blocked this call');
      // The echo upstream answers everything, so a reply that came from it would
      // have carried echoedMethod instead.
      expect(reply).not.toContain('echoedMethod');
      streams.input.end();
      await exit;
    });

    it('forwards a tool the policy does not deny', async () => {
      const path = policyFile('mode: enforce\nservers:\n  node:\n    deny_tools: ["delete_*"]\n');
      const streams = io();
      const exit = run(
        ['--policy', path, '--server', 'node', '--', process.execPath, FIXTURE],
        streams,
      );

      streams.input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a' } } })}\n`,
      );
      const [reply] = await readLines(streams.output, 1);

      expect(reply).toContain('echoedMethod');
      streams.input.end();
      await exit;
    });

    it('says once that no model will be asked, and keeps going', async () => {
      const streams = io();
      const exit = run(['--', process.execPath, FIXTURE], streams);
      streams.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      await readLines(streams.output, 1);
      streams.input.end();
      await exit;

      const written = streams.stderr();
      expect(written).toContain('TYPESAFE_API_KEY is not set');
      expect(written.match(/TYPESAFE_API_KEY is not set/g)).toHaveLength(1);
    });

    it('records a judgment for every call it screened', async () => {
      const path = policyFile('mode: enforce\nservers:\n  node:\n    deny_tools: ["delete_*"]\n');
      const streams = io();
      const exit = run(
        ['--policy', path, '--server', 'node', '--', process.execPath, FIXTURE],
        streams,
      );

      streams.input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_file', arguments: {} } })}\n`,
      );
      await readLines(streams.output, 1);
      streams.input.end();
      await exit;

      const judgment = streams
        .stderr()
        .split('\n')
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })
        .find((entry) => entry?.['side'] === 'call');
      expect(judgment).toMatchObject({ tool: 'delete_file', screened: false, mode: 'enforce' });
    });

    it('refuses to start on a policy file it cannot read', async () => {
      const path = policyFile('mode: definitely-not-a-mode\n');
      const streams = io();

      await expect(run(['--policy', path, '--', process.execPath, FIXTURE], streams)).resolves.toBe(
        64,
      );
      expect(streams.stderr()).toContain('could not be read');
    });

    it('rejects an option it does not know rather than treating it as a command', () => {
      expect(parseArguments(['--nope', '--', 'node'])).toBeUndefined();
    });

    it('reads the policy path and server name from the arguments', () => {
      expect(
        parseArguments(['--policy', '/tmp/p.yaml', '--server', 'files', '--', 'node', 'x']),
      ).toEqual({ command: 'node', args: ['x'], policyPath: '/tmp/p.yaml', server: 'files' });
    });
  });
});
