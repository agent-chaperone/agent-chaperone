import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createProxy } from './proxy.js';
import { UpstreamStartError, environmentForUpstream, spawnUpstream } from './upstream.js';
import { readLines } from './__fixtures__/streams.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/echo-upstream.mjs', import.meta.url));

function wrapRealUpstream() {
  const upstream = spawnUpstream(process.execPath, [FIXTURE]);
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const proxy = createProxy({
    clientInput,
    clientOutput,
    upstreamInput: upstream.stdin,
    upstreamOutput: upstream.stdout,
  });
  return { upstream, clientInput, clientOutput, proxy };
}

describe('proxying a real upstream process', () => {
  it('round-trips tools/list and tools/call unchanged in both directions', async () => {
    const h = wrapRealUpstream();
    const list = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
    const call =
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"a.txt"}}}';

    h.clientInput.write(`${list}\n`);
    h.clientInput.write(`${call}\n`);
    const replies = await readLines(h.clientOutput, 2);

    expect(JSON.parse(replies[0] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { echoedMethod: 'tools/list', echoedParams: {} },
    });
    expect(JSON.parse(replies[1] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {
        echoedMethod: 'tools/call',
        echoedParams: { name: 'read_file', arguments: { path: 'a.txt' } },
      },
    });

    h.clientInput.end();
    await expect(h.upstream.exited).resolves.toBe(0);
  });

  it('carries an unknown top-level field all the way to the server', async () => {
    const h = wrapRealUpstream();
    h.clientInput.write(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"a":1},"experimentalFlag":true}\n',
    );
    const [reply] = await readLines(h.clientOutput, 1);
    expect(JSON.parse(reply ?? '{}')).toMatchObject({ result: { echoedMethod: 'tools/call' } });
    h.clientInput.end();
    await h.upstream.exited;
  });

  it('relays output that is not valid JSON without altering it', async () => {
    const h = wrapRealUpstream();
    h.clientInput.write('{"jsonrpc":"2.0","id":1,"method":"test/garbage"}\n');
    expect(await readLines(h.clientOutput, 1)).toEqual(['{ this is not valid json']);
    h.clientInput.end();
    await h.upstream.exited;
  });

  it('reports the exit code when the server dies mid-session', async () => {
    const h = wrapRealUpstream();
    h.clientInput.write('{"jsonrpc":"2.0","id":1,"method":"test/crash"}\n');
    await expect(h.upstream.exited).resolves.toBe(3);
    await expect(h.proxy.closed).resolves.toBeUndefined();
  });

  it('ends the session when the client disconnects', async () => {
    const h = wrapRealUpstream();
    h.clientInput.end();
    await expect(h.upstream.exited).resolves.toBe(0);
  });
});

describe('spawnUpstream', () => {
  it('explains a missing command without exposing internal paths', async () => {
    const upstream = spawnUpstream('agent-chaperone-no-such-command', []);
    await expect(upstream.exited).rejects.toThrow(UpstreamStartError);
    const error = await upstream.exited.catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain('agent-chaperone-no-such-command');
    expect(message).not.toContain('/src/');
    expect(message).not.toContain('node_modules');
    expect(message).not.toContain(process.cwd());
  });
});

describe('byte-level transparency through a real process', () => {
  it('delivers the exact bytes the client sent, not a reserialisation', async () => {
    const h = wrapRealUpstream();
    // Odd spacing and key order that any reserialisation would normalise away.
    const line = '{  "method":"test/raw", "jsonrpc":"2.0",  "id":9, "params":{"z":1,"a":2} }';
    h.clientInput.write(`${line}\n`);
    const [reply] = await readLines(h.clientOutput, 1);
    expect(JSON.parse(reply ?? '{}').result.raw).toBe(line);
    h.clientInput.end();
    await h.upstream.exited;
  });

  it('delivers an unknown top-level field to the server intact', async () => {
    const h = wrapRealUpstream();
    const line = '{"jsonrpc":"2.0","id":1,"method":"test/raw","vendorField":{"keep":"me"}}';
    h.clientInput.write(`${line}\n`);
    const [reply] = await readLines(h.clientOutput, 1);
    const seen: unknown = JSON.parse(JSON.parse(reply ?? '{}').result.raw);
    expect(seen).toMatchObject({ vendorField: { keep: 'me' } });
    h.clientInput.end();
    await h.upstream.exited;
  });

  it('delivers the exact bytes the server sent back to the client', async () => {
    const h = wrapRealUpstream();
    h.clientInput.write('{"jsonrpc":"2.0","id":1,"method":"test/garbage"}\n');
    expect(await readLines(h.clientOutput, 1)).toEqual(['{ this is not valid json']);
    h.clientInput.end();
    await h.upstream.exited;
  });

  it('hands the client environment to the server', async () => {
    const h = wrapRealUpstream();
    h.clientInput.write('{"jsonrpc":"2.0","id":1,"method":"test/env","params":{"name":"PATH"}}\n');
    const [reply] = await readLines(h.clientOutput, 1);
    expect(JSON.parse(reply ?? '{}').result.seen).toBe(process.env['PATH']);
    h.clientInput.end();
    await h.upstream.exited;
  });

  it('kill() stops a server that would otherwise keep running', async () => {
    const upstream = spawnUpstream(process.execPath, [FIXTURE]);
    upstream.kill();
    await expect(upstream.exited).resolves.toBeTypeOf('number');
  });
});

describe('environmentForUpstream', () => {
  it('keeps the environment the client provided', () => {
    const env = environmentForUpstream({ PATH: '/usr/bin', MY_SETTING: 'x' });
    expect(env).toEqual({ PATH: '/usr/bin', MY_SETTING: 'x' });
  });

  it('withholds the chaperone credentials from the process it is screening', () => {
    const env = environmentForUpstream({
      PATH: '/usr/bin',
      TYPESAFE_API_KEY: 'secret',
      OPENROUTER_API_KEY: 'secret',
      AI_GATEWAY_API_KEY: 'secret',
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('does not mutate the environment it was given', () => {
    const source = { TYPESAFE_API_KEY: 'secret' };
    environmentForUpstream(source);
    expect(source.TYPESAFE_API_KEY).toBe('secret');
  });

  it('withholds them from a really spawned server', async () => {
    process.env['TYPESAFE_API_KEY'] = 'must-not-reach-the-server';
    try {
      const h = wrapRealUpstream();
      h.clientInput.write(
        '{"jsonrpc":"2.0","id":1,"method":"test/env","params":{"name":"TYPESAFE_API_KEY"}}\n',
      );
      const [reply] = await readLines(h.clientOutput, 1);
      expect(JSON.parse(reply ?? '{}').result.seen).toBeNull();
      h.clientInput.end();
      await h.upstream.exited;
    } finally {
      delete process.env['TYPESAFE_API_KEY'];
    }
  });
});
