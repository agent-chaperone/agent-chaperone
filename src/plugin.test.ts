import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAIN,
  RETRY_AFTER_MS,
  coolingDown,
  failureMarker,
  installCommand,
  installEnv,
  onPath,
  planFor,
  pluginVersion,
  quietEnv,
  runtimeDir,
  runtimeMain,
} from '../scripts/plugin-hook-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = join(ROOT, 'scripts', 'plugin-hook.mjs');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const PACKAGE = JSON.parse(read('package.json')) as {
  version: string;
  bin: Record<string, string>;
};
const VERSION = PACKAGE.version;

interface HookEntry {
  readonly matcher: string;
  readonly hooks: readonly { readonly type: string; readonly command: string }[];
}
type HookConfig = Readonly<Record<string, readonly HookEntry[]>>;

const temporary: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaperone-plugin-'));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the plugin manifests', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json')) as Record<string, unknown>;
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as {
    name: string;
    plugins: { name: string; source: string }[];
  };

  it('names the plugin after the package', () => {
    expect(plugin['name']).toBe('agent-chaperone');
  });

  it('leaves the version out, so updates follow the repository', () => {
    // A version here pins the plugin to that string until someone bumps it by
    // hand, and nothing would remind them. Without one the plugin follows the
    // repository, and the launcher reads the package version instead, which the
    // release already bumps.
    expect(plugin).not.toHaveProperty('version');
  });

  it('lists the plugin from the root of this repository', () => {
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: 'agent-chaperone', source: './' }),
    ]);
  });
});

describe('the plugin hooks match the documented configuration', () => {
  // The plugin and docs/hooks.md describe the same setup two ways, and a matcher
  // that drifts in one of them fails silently: a tool that is not matched is
  // simply never screened.
  const documented = ((): HookConfig => {
    const doc = read('docs/hooks.md');
    // The exact heading, so a later heading that starts the same way cannot be taken for it.
    const section = doc.slice(doc.indexOf('\n## Claude Code\n'));
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    if (block === undefined) {
      throw new Error('docs/hooks.md has no JSON block under "## Claude Code"');
    }
    return (JSON.parse(block) as { hooks: HookConfig }).hooks;
  })();
  const plugin = (JSON.parse(read('hooks/hooks.json')) as { hooks: HookConfig }).hooks;

  it('registers the same events', () => {
    expect(Object.keys(plugin).sort()).toEqual(Object.keys(documented).sort());
  });

  for (const event of Object.keys(documented)) {
    it(`matches the same tools on ${event}`, () => {
      expect(plugin[event]?.map((entry) => entry.matcher)).toEqual(
        documented[event]?.map((entry) => entry.matcher),
      );
    });

    it(`runs the same side of the hook on ${event}`, () => {
      const side = (command: string | undefined): string | undefined =>
        /\b(pre|post)$/.exec(command ?? '')?.[1];
      expect(side(plugin[event]?.[0]?.hooks[0]?.command)).toBe(
        side(documented[event]?.[0]?.hooks[0]?.command),
      );
    });
  }

  it('runs the launcher from the plugin root on every event', () => {
    for (const entries of Object.values(plugin)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.command).toMatch(
            /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/plugin-hook\.mjs" (pre|post)$/,
          );
        }
      }
    }
  });
});

describe('pluginVersion', () => {
  it('reads the version the package is published at', () => {
    expect(pluginVersion(read('package.json'))).toBe(VERSION);
  });

  it('accepts a prerelease', () => {
    expect(pluginVersion('{"version":"1.2.3-rc.1"}')).toBe('1.2.3-rc.1');
  });

  it('refuses anything that is not a plain version, since it lands on a command line', () => {
    expect(pluginVersion('{"version":"1.2.3 && echo hi"}')).toBeUndefined();
    expect(pluginVersion('{"version":"latest"}')).toBeUndefined();
    expect(pluginVersion('{"version":1}')).toBeUndefined();
    expect(pluginVersion('{}')).toBeUndefined();
    expect(pluginVersion('not json')).toBeUndefined();
  });
});

describe('where the launcher looks for the command', () => {
  it('matches the bin the package declares', () => {
    // The launcher runs an install directly rather than through npm's bin shim,
    // so it has to know the path, and the two must not drift.
    expect(join('node_modules', 'agent-chaperone', PACKAGE.bin['agent-chaperone'] ?? '')).toBe(
      join(...MAIN),
    );
  });

  it('keeps one directory per version under the data directory', () => {
    expect(runtimeDir('/data', '1.2.3')).toBe(join('/data', 'agent-chaperone-1.2.3'));
    expect(runtimeMain('/data/x')).toBe(join('/data/x', ...MAIN));
  });
});

describe('planFor', () => {
  const base = { version: '1.0.0', dataDir: '/data', installed: false, platform: 'linux' };

  it('prefers an agent-chaperone already on the path', () => {
    expect(planFor('pre', { ...base, globalInstalled: true })).toEqual({
      kind: 'global',
      command: 'agent-chaperone',
      args: ['hook', 'pre'],
      shell: false,
    });
  });

  it('installs the matching version into the data directory the first time', () => {
    expect(planFor('pre', { ...base, globalInstalled: false })).toEqual({
      kind: 'install',
      dir: runtimeDir('/data', '1.0.0'),
      main: runtimeMain(runtimeDir('/data', '1.0.0')),
    });
  });

  it('runs that copy directly once it is there', () => {
    expect(planFor('post', { ...base, globalInstalled: false, installed: true })?.kind).toBe(
      'installed',
    );
  });

  it('falls back to npx without a data directory, and never with --prefer-offline', () => {
    const plan = planFor('post', { ...base, globalInstalled: false, dataDir: undefined });
    expect(plan).toEqual({
      kind: 'npx',
      command: 'npx',
      args: ['--yes', 'agent-chaperone@1.0.0', 'hook', 'post'],
      shell: false,
    });
  });

  it('goes through a shell on Windows, where the commands are .cmd shims', () => {
    const plan = planFor('pre', { ...base, globalInstalled: true, platform: 'win32' });
    expect(plan !== undefined && 'shell' in plan && plan.shell).toBe(true);
  });

  it('has nothing to do with no install and no version', () => {
    expect(planFor('pre', { ...base, globalInstalled: false, version: undefined })).toBeUndefined();
  });
});

describe('installCommand', () => {
  it('asks the registry for a fresh list of versions and passes no path', () => {
    const { command, args } = installCommand('1.0.0', 'linux');
    expect(command).toBe('npm');
    expect(args).toContain('--prefer-online');
    expect(args).not.toContain('--prefer-offline');
    expect(args.at(-1)).toBe('agent-chaperone@1.0.0');
    // The staging directory is the working directory, never an argument, so a
    // space in the home directory cannot split a Windows command line.
    expect(args.some((arg) => arg.includes('/') || arg.includes('\\'))).toBe(false);
  });

  it('gives the install an npm cache of its own, so a root-owned ~/.npm cannot break it', () => {
    expect(installEnv({}, '/data')).toMatchObject({ npm_config_cache: join('/data', 'npm-cache') });
  });

  it('keeps npm quiet', () => {
    expect(quietEnv({ PATH: '/bin' })).toMatchObject({
      PATH: '/bin',
      npm_config_loglevel: 'error',
      npm_config_update_notifier: 'false',
    });
  });
});

describe('coolingDown', () => {
  const now = 1_000_000_000_000;

  it('skips another attempt soon after a failure', () => {
    expect(coolingDown(String(now - 1000), now)).toBe(true);
  });

  it('tries again once the wait is over', () => {
    expect(coolingDown(String(now - RETRY_AFTER_MS), now)).toBe(false);
  });

  it('treats an unreadable or impossible marker as no marker, costing one retry rather than a lockout', () => {
    expect(coolingDown('garbage', now)).toBe(false);
    expect(coolingDown('', now)).toBe(false);
    expect(coolingDown(String(now + 60_000), now)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('onPath', () => {
  it('finds an executable file', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
    chmodSync(join(dir, 'tool'), 0o755);
    expect(onPath('tool', `/nowhere:${dir}`)).toBe(true);
  });

  it('ignores a file that cannot be run', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'tool'), '');
    chmodSync(join(dir, 'tool'), 0o644);
    expect(onPath('tool', dir)).toBe(false);
  });

  it('ignores a directory with the same name', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'tool'));
    expect(onPath('tool', dir)).toBe(false);
  });

  it('finds nothing on an empty path', () => {
    expect(onPath('tool', '')).toBe(false);
    expect(onPath('tool', undefined)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')(
  'the launcher, run the way Claude Code runs it',
  () => {
    // Stand-ins for agent-chaperone, npx and npm, written in JavaScript so the test
    // path can hold nothing but the directory they sit in.
    const node = process.execPath;

    /** A command that reports how it was called, echoes stdin, and exits with FAKE_EXIT. */
    const reporter = (label: string): string =>
      [
        `#!${node}`,
        "let input = '';",
        "process.stdin.on('data', (c) => (input += c));",
        "process.stdin.on('end', () => {",
        `  process.stdout.write('ran:${label} ' + process.argv.slice(2).join(' ') + '\\n' + input);`,
        "  process.exit(Number(process.env.FAKE_EXIT ?? '0'));",
        '});',
        '',
      ].join('\n');

    function executable(dir: string, name: string, body: string): void {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }

    /** An npm that records each call, prints what npm prints, and installs a reporter as the package. */
    function fakeNpm(dir: string, log: string, fails = false): void {
      executable(
        dir,
        'npm',
        [
          `#!${node}`,
          "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
          "const { join } = require('node:path');",
          `appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + ' cache=' + process.env.npm_config_cache + '\\n');`,
          "process.stdout.write('added 12 packages in 3s\\n');",
          fails ? 'process.exit(1);' : '',
          `const main = join(process.cwd(), ...${JSON.stringify(MAIN)});`,
          'mkdirSync(join(main, ".."), { recursive: true });',
          `writeFileSync(main, ${JSON.stringify(reporter('installed').split('\n').slice(1).join('\n'))});`,
          '',
        ].join('\n'),
      );
    }

    function launch(side: string, env: Record<string, string>, input = '{"tool_name":"Bash"}') {
      return spawnSync(node, [LAUNCHER, side], { input, env, encoding: 'utf8' });
    }

    it('runs a global install with the payload on stdin and its answer on stdout', () => {
      const bin = scratch();
      executable(bin, 'agent-chaperone', reporter('global'));
      const run = launch('pre', { PATH: bin, CLAUDE_PLUGIN_DATA: scratch() });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('ran:global hook pre\n{"tool_name":"Bash"}');
    });

    it('installs the matching version once, then runs it directly', () => {
      const bin = scratch();
      const data = scratch();
      const log = join(scratch(), 'npm.log');
      fakeNpm(bin, log);

      const first = launch('pre', { PATH: bin, CLAUDE_PLUGIN_DATA: data });
      expect(first.status).toBe(0);
      expect(first.stdout).toBe('ran:installed hook pre\n{"tool_name":"Bash"}');
      expect(existsSync(runtimeMain(runtimeDir(data, VERSION)))).toBe(true);

      const second = launch('post', { PATH: bin, CLAUDE_PLUGIN_DATA: data });
      expect(second.stdout.split('\n')[0]).toBe('ran:installed hook post');

      const calls = readFileSync(log, 'utf8').trim().split('\n');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(`--prefer-online`);
      expect(calls[0]).toContain(`agent-chaperone@${VERSION}`);
    });

    it("keeps npm's own output off stdout, which would switch the screen off", () => {
      const bin = scratch();
      fakeNpm(bin, join(scratch(), 'npm.log'));
      const run = launch('pre', { PATH: bin, CLAUDE_PLUGIN_DATA: scratch() });
      expect(run.stdout).not.toContain('added 12 packages');
      expect(run.stderr).toContain('added 12 packages');
    });

    it('leaves no staging directory behind', () => {
      const bin = scratch();
      const data = scratch();
      fakeNpm(bin, join(scratch(), 'npm.log'));
      launch('pre', { PATH: bin, CLAUDE_PLUGIN_DATA: data });
      expect(readdirSync(data)).toEqual([`agent-chaperone-${VERSION}`]);
    });

    it('installs with an npm cache inside the data directory', () => {
      const bin = scratch();
      const data = scratch();
      const log = join(scratch(), 'npm.log');
      fakeNpm(bin, log);
      launch('pre', { PATH: bin, CLAUDE_PLUGIN_DATA: data });
      expect(readFileSync(log, 'utf8')).toContain(` cache=${join(data, 'npm-cache')}`);
    });

    it('does not try a failed install again on the next call, which would stall every tool call', () => {
      const bin = scratch();
      const data = scratch();
      const log = join(scratch(), 'npm.log');
      fakeNpm(bin, log, true);
      expect(launch('pre', { PATH: bin, CLAUDE_PLUGIN_DATA: data }).status).toBe(1);
      const second = launch('post', { PATH: bin, CLAUDE_PLUGIN_DATA: data });
      expect(second.status).toBe(1);
      expect(second.stdout).toBe('');
      expect(second.stderr).toContain('retried ten minutes after that');
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('tries again once the last failure is old enough, and forgets it on success', () => {
      const bin = scratch();
      const data = scratch();
      const log = join(scratch(), 'npm.log');
      fakeNpm(bin, log);
      writeFileSync(failureMarker(data, VERSION), `${Date.now() - RETRY_AFTER_MS - 1}\n`);
      const run = launch('pre', { PATH: bin, CLAUDE_PLUGIN_DATA: data });
      expect(run.status).toBe(0);
      expect(existsSync(failureMarker(data, VERSION))).toBe(false);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('exits 1 rather than 2 when the install fails, so the call is not blocked', () => {
      const bin = scratch();
      fakeNpm(bin, join(scratch(), 'npm.log'), true);
      const run = launch('pre', { PATH: bin, CLAUDE_PLUGIN_DATA: scratch() });
      expect(run.status).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('could not install');
    });

    it('falls back to npx when there is no data directory', () => {
      const bin = scratch();
      executable(bin, 'npx', reporter('npx'));
      const run = launch('post', { PATH: bin });
      expect(run.status).toBe(0);
      expect(run.stdout.split('\n')[0]).toBe(`ran:npx --yes agent-chaperone@${VERSION} hook post`);
    });

    it('passes the command exit code through, since that one is a decision', () => {
      const bin = scratch();
      executable(bin, 'agent-chaperone', reporter('global'));
      expect(launch('pre', { PATH: bin, FAKE_EXIT: '70' }).status).toBe(70);
    });

    it('exits 1 rather than 2 when there is nothing to run', () => {
      const run = launch('pre', { PATH: scratch() });
      expect(run.status).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('agent-chaperone plugin:');
    });

    it('runs when started through a symlink, as a plugin cache often is', () => {
      // This once exited 0 having done nothing. An entry-point check compared the
      // file's real path with the path it was started by, and a symlink anywhere on
      // the way made them differ, which switched every screen off without a word.
      const bin = scratch();
      executable(bin, 'agent-chaperone', reporter('global'));
      const linked = join(scratch(), 'plugin');
      symlinkSync(ROOT, linked);
      const run = spawnSync(node, [join(linked, 'scripts', 'plugin-hook.mjs'), 'pre'], {
        input: '{}',
        env: { PATH: bin },
        encoding: 'utf8',
      });
      expect(run.status).toBe(0);
      expect(run.stdout.split('\n')[0]).toBe('ran:global hook pre');
    });

    it('refuses a side it does not know, without blocking', () => {
      const bin = scratch();
      executable(bin, 'agent-chaperone', reporter('global'));
      const run = launch('sideways', { PATH: bin });
      expect(run.status).toBe(1);
      expect(run.stdout).toBe('');
    });
  },
);
