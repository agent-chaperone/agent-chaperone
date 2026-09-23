/**
 * What the plugin's hook launcher decides before it starts anything: which
 * version it would run, whether a global install is on the path, and where the
 * plugin keeps its own copy. Kept apart from `plugin-hook.mjs` so that file can
 * run unconditionally, and so these can be tested without starting it.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

export const SIDES = ['pre', 'post'];

/** A published version, and nothing that could carry anything else onto a command line. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Where the package keeps its command, relative to an install. Checked against package.json by a test. */
export const MAIN = ['node_modules', 'agent-chaperone', 'dist', 'cli', 'main.js'];

/** The version this checkout carries, or undefined when it cannot be read. */
export function pluginVersion(packageJson) {
  let version;
  try {
    version = JSON.parse(packageJson).version;
  } catch {
    return undefined;
  }
  return typeof version === 'string' && SEMVER.test(version) ? version : undefined;
}

/** Whether `name` is an executable file in one of the directories on this path. */
export function onPath(
  name,
  pathValue,
  platform = process.platform,
  pathExt = process.env.PATHEXT,
) {
  const windows = platform === 'win32';
  const extensions = windows ? (pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (pathValue ?? '').split(windows ? ';' : ':')) {
    if (dir === '') {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      try {
        // A directory is searchable, which passes an executable check on its own.
        if (statSync(candidate).isFile()) {
          accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
          return true;
        }
      } catch {
        // Not here.
      }
    }
  }
  return false;
}

/** The directory one version is installed into, inside the plugin's data directory. */
export function runtimeDir(dataDir, version) {
  return join(dataDir, `agent-chaperone-${version}`);
}

/** The command inside an install. */
export function runtimeMain(dir) {
  return join(dir, ...MAIN);
}

/**
 * What to do for one side of the hook, or undefined when there is nothing to do.
 *
 * A global install comes first, because putting one on the path is a choice the
 * user made. Then the plugin's own copy of the matching version, installed once
 * into the data directory Claude Code gives the plugin and run directly after
 * that, which costs a node start and nothing else.
 *
 * npx is the last resort, for a launcher started somewhere without that data
 * directory. It resolves the version against the registry on every call, which
 * is slow, and deliberately not with --prefer-offline: that trusts npm's cached
 * list of versions, and a list cached before a release says the release does not
 * exist, so every call would fail until something else refreshed it.
 *
 * Windows starts `npx`, `npm` and a global install through `.cmd` shims, which
 * Node will only run through a shell. Nothing that reaches such a command line is
 * a path or anything from the payload: the arguments are fixed words and a
 * version that has already matched SEMVER.
 */
export function planFor(
  side,
  { version, globalInstalled, dataDir, installed, platform = process.platform },
) {
  const shell = platform === 'win32';
  if (globalInstalled) {
    return { kind: 'global', command: 'agent-chaperone', args: ['hook', side], shell };
  }
  if (version === undefined) {
    return undefined;
  }
  if (dataDir !== undefined && dataDir !== '') {
    const dir = runtimeDir(dataDir, version);
    return { kind: installed ? 'installed' : 'install', dir, main: runtimeMain(dir) };
  }
  return {
    kind: 'npx',
    command: 'npx',
    args: ['--yes', `agent-chaperone@${version}`, 'hook', side],
    shell,
  };
}

/** The install command, run with the staging directory as its working directory so no path is an argument. */
export function installCommand(version, platform = process.platform) {
  return {
    command: 'npm',
    // --prefer-online so the list of versions is fetched fresh: this runs once
    // per release, and a stale list is the thing that makes a release look absent.
    args: [
      'install',
      '--prefer-online',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      `agent-chaperone@${version}`,
    ],
    shell: platform === 'win32',
  };
}

/**
 * The environment for the install: quiet, and with an npm cache of its own
 * inside the plugin's data directory.
 *
 * Its own cache because a user's npm cache is often not writable by the user:
 * one `sudo npm install` long ago leaves files in it owned by root, and every
 * later install fails with EACCES. The plugin should not depend on that, and a
 * cache in the data directory is removed with the plugin.
 */
export function installEnv(env, dataDir) {
  return { ...quietEnv(env), npm_config_cache: join(dataDir, 'npm-cache') };
}

/** How long a failed install is left alone before it is tried again. */
export const RETRY_AFTER_MS = 10 * 60 * 1000;

/** The file that records when an install of this version last failed. */
export function failureMarker(dataDir, version) {
  return join(dataDir, `install-failed-${version}`);
}

/**
 * Whether a recorded failure is recent enough to skip another attempt.
 *
 * Without this every screened call would try the install again, and an install
 * that cannot reach the registry waits on npm's retries each time, which is
 * minutes per tool call rather than one error. A marker that cannot be read is
 * treated as absent, so a damaged file costs one retry rather than a lockout.
 */
export function coolingDown(markerText, now) {
  const at = Number(markerText);
  return Number.isFinite(at) && at <= now && now - at < RETRY_AFTER_MS;
}

/** npm told to say as little as it can, since none of it is any use inside a hook. */
export function quietEnv(env) {
  return {
    ...env,
    npm_config_loglevel: 'error',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}
