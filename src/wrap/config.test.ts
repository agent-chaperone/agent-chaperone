import { describe, expect, it } from 'vitest';
import { COMMAND, formatChanges, isWrapped, rewrite } from './index.js';

const config = (servers: Record<string, unknown>, section = 'mcpServers') => ({
  [section]: servers,
});
const filesystem = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
};

const entryFor = (
  result: { config: Record<string, unknown> },
  name: string,
  section = 'mcpServers',
) => (result.config[section] as Record<string, Record<string, unknown>>)[name];

describe('putting a client config behind the screen', () => {
  it('rewrites a server to run through the proxy', () => {
    const done = rewrite(config({ filesystem }));

    expect(entryFor(done, 'filesystem')).toEqual({
      command: COMMAND,
      args: [
        '--server',
        'filesystem',
        '--',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '.',
      ],
    });
  });

  it('names the policy section after the key in this file', () => {
    const done = rewrite(config({ 'my-files': filesystem }));
    const args = entryFor(done, 'my-files')['args'] as string[];

    // So what someone writes under `servers:` in their policy matches what they
    // already see in their client.
    expect(args.slice(0, 2)).toEqual(['--server', 'my-files']);
  });

  it('wraps an http server, now that a URL is an upstream', () => {
    const done = rewrite(config({ remote: { url: 'https://example.com/mcp' } }));

    expect(entryFor(done, 'remote')).toEqual({
      command: COMMAND,
      args: ['--server', 'remote', '--', 'https://example.com/mcp'],
    });
  });

  it('keeps everything else about an entry', () => {
    const done = rewrite(config({ filesystem: { ...filesystem, env: { TOKEN: 'x' } } }));

    expect(entryFor(done, 'filesystem')['env']).toEqual({ TOKEN: 'x' });
  });

  it('understands both spellings of the section', () => {
    const done = rewrite(config({ filesystem }, 'servers'));

    expect(entryFor(done, 'filesystem', 'servers')['command']).toBe(COMMAND);
  });

  it('leaves the rest of the file alone', () => {
    const done = rewrite({ ...config({ filesystem }), theme: 'dark', other: { a: 1 } });

    expect(done.config['theme']).toBe('dark');
    expect(done.config['other']).toEqual({ a: 1 });
  });

  it('does not wrap something already wrapped', () => {
    const once = rewrite(config({ filesystem }));
    const twice = rewrite(once.config);

    expect(twice.changes).toEqual([{ kind: 'already', name: 'filesystem' }]);
    expect(entryFor(twice, 'filesystem')).toEqual(entryFor(once, 'filesystem'));
  });

  it('recognises the npx form the README documents', () => {
    expect(isWrapped({ command: 'npx', args: ['-y', COMMAND, '--', 'node', 'server.js'] })).toBe(
      true,
    );
  });

  it('does not mistake an upstream that is named like this one', () => {
    // The name after the separator is the server being wrapped, not this.
    expect(isWrapped({ command: 'npx', args: ['-y', 'some-server', '--', COMMAND] })).toBe(false);
  });

  it('skips an entry it cannot reach rather than breaking it', () => {
    const done = rewrite(config({ odd: { transport: 'websocket' } }));

    expect(done.changes[0]?.kind).toBe('skipped');
    expect(entryFor(done, 'odd')).toEqual({ transport: 'websocket' });
  });

  it('skips something that is not a server entry', () => {
    const done = rewrite(config({ broken: 'not an object' }));

    expect(done.changes[0]?.kind).toBe('skipped');
  });

  it('is empty rather than throwing on a file that is not a config', () => {
    for (const junk of [null, 42, 'text', []]) {
      expect(rewrite(junk).changes).toEqual([]);
    }
  });

  it('says so when there are no servers at all', () => {
    expect(formatChanges(rewrite({ theme: 'dark' }).changes, false)).toContain('No servers found');
  });
});

describe('taking a client config back out', () => {
  it('restores the command and args it started with', () => {
    const wrapped = rewrite(config({ filesystem }));
    const back = rewrite(wrapped.config, { unwrap: true });

    expect(entryFor(back, 'filesystem')).toEqual(filesystem);
  });

  it('restores a url entry as a url', () => {
    const wrapped = rewrite(config({ remote: { url: 'https://example.com/mcp' } }));
    const back = rewrite(wrapped.config, { unwrap: true });

    expect(entryFor(back, 'remote')).toEqual({ url: 'https://example.com/mcp' });
  });

  it('round-trips a server that takes no arguments', () => {
    const wrapped = rewrite(config({ solo: { command: 'my-server' } }));
    const back = rewrite(wrapped.config, { unwrap: true });

    expect(entryFor(back, 'solo')).toEqual({ command: 'my-server' });
  });

  it('keeps the rest of the entry through the round trip', () => {
    const original = { ...filesystem, env: { TOKEN: 'x' } };
    const back = rewrite(rewrite(config({ filesystem: original })).config, { unwrap: true });

    expect(entryFor(back, 'filesystem')).toEqual(original);
  });

  it('leaves an entry that was never wrapped', () => {
    const done = rewrite(config({ filesystem }), { unwrap: true });

    expect(done.changes).toEqual([{ kind: 'already', name: 'filesystem' }]);
    expect(entryFor(done, 'filesystem')).toEqual(filesystem);
  });

  it('is safe to run twice', () => {
    const once = rewrite(rewrite(config({ filesystem })).config, { unwrap: true });
    const twice = rewrite(once.config, { unwrap: true });

    expect(entryFor(twice, 'filesystem')).toEqual(filesystem);
  });
});
