#!/usr/bin/env node
/**
 * The command the Claude Code plugin's hooks run.
 *
 * Installing the plugin should be enough on its own. So this runs a global
 * `agent-chaperone` when one is on the path, and otherwise the plugin's own copy
 * of the matching version, which it installs once into the data directory Claude
 * Code gives the plugin and runs directly after that. The version is read from
 * the package.json beside this file, so the plugin and what it launches come from
 * the same commit and cannot drift apart. What decides between those lives in
 * plugin-hook-lib.mjs.
 *
 * Four parts of the hook contract decide how it is written.
 *
 * stdout is the decision. Claude Code parses it as JSON, and anything that is not
 * JSON is reported as a non-blocking error while the call goes ahead. So nothing
 * here writes to stdout, and npm's own stdout during an install is sent to
 * stderr: a line like "added 12 packages" reaching the client would switch the
 * screen off without a word.
 *
 * Exit 2 blocks the tool call. A failure of this launcher is not a decision about
 * the call, so it exits 1, which the client reports and carries on from. The
 * command's own exit code is passed through unchanged, because that one is.
 *
 * stdin is the payload. It is read whole before anything starts, so an install on
 * first use cannot eat it.
 *
 * The working directory is left alone for the command, because it reads the
 * recorded task from there. The install runs in a staging directory of its own,
 * with its own package.json, so a project's package.json is never touched and a
 * checkout of this repository is never mistaken for the package.
 *
 * It runs unconditionally, with no check that it was started directly rather
 * than imported. That check compares this file's path with the one it was
 * started by, and the two differ whenever a directory on the way is a symlink,
 * which a plugin cache under the home directory often is. The check then skipped
 * everything and exited 0, which switched every screen off without a word.
 *
 * Usage: node scripts/plugin-hook.mjs <pre|post>
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  SIDES,
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
} from './plugin-hook-lib.mjs';

function readStdin() {
  return new Promise((done, fail) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => done(Buffer.concat(chunks)));
    process.stdin.on('error', fail);
  });
}

function refuse(reason) {
  process.stderr.write(`agent-chaperone plugin: ${reason}\n`);
  process.exitCode = 1;
}

/** Settles with the exit code, or -1 when the program could not be started at all. */
function finished(child) {
  return new Promise((done) => {
    let started = true;
    child.on('error', () => {
      started = false;
      done(-1);
    });
    child.on('close', (code) => {
      if (started) {
        // A child killed by a signal has no code, and that is a failure, not a decision.
        done(code ?? 1);
      }
    });
  });
}

/**
 * Install one version into the data directory, and report whether it is there.
 *
 * Into a staging directory first and then renamed into place, because two tool
 * calls can reach an empty data directory at once and a rename is the one step
 * that either happens whole or not at all. The loser of that race finds the
 * winner's copy and uses it. A failure is recorded, so the calls after it fail
 * at once instead of each waiting on npm again.
 */
async function install(dataDir, version) {
  const dir = runtimeDir(dataDir, version);
  mkdirSync(dataDir, { recursive: true });
  const staging = mkdtempSync(join(dataDir, '.install-'));
  try {
    writeFileSync(join(staging, 'package.json'), '{ "private": true }\n');
    const { command, args, shell } = installCommand(version);
    const code = await finished(
      spawn(command, args, {
        cwd: staging,
        // npm's stdout goes to stderr: see the header.
        stdio: ['ignore', 2, 'inherit'],
        shell,
        env: installEnv(process.env, dataDir),
      }),
    );
    if (code === 0 && existsSync(runtimeMain(staging))) {
      try {
        renameSync(staging, dir);
      } catch {
        // Another hook finished first, and its copy is the same version.
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const installed = existsSync(runtimeMain(dir));
  if (installed) {
    rmSync(failureMarker(dataDir, version), { force: true });
  } else {
    writeFileSync(failureMarker(dataDir, version), `${Date.now()}\n`);
  }
  return installed;
}

/** When the last install of this version failed, if that was recently enough to skip another try. */
function recentFailure(dataDir, version) {
  try {
    const text = readFileSync(failureMarker(dataDir, version), 'utf8');
    return coolingDown(text.trim(), Date.now()) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const side = process.argv[2];
  if (!SIDES.includes(side)) {
    refuse(`expected "pre" or "post", got ${JSON.stringify(side)}`);
    return;
  }

  let version;
  try {
    version = pluginVersion(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  } catch {
    version = undefined;
  }
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const plan = planFor(side, {
    version,
    globalInstalled: onPath('agent-chaperone', process.env.PATH),
    dataDir,
    installed:
      dataDir !== undefined && dataDir !== '' && version !== undefined
        ? existsSync(runtimeMain(runtimeDir(dataDir, version)))
        : false,
  });
  if (plan === undefined) {
    refuse('agent-chaperone is not on the path and the plugin has no version to install');
    return;
  }

  const input = await readStdin();

  if (plan.kind === 'install') {
    const failedAt = recentFailure(dataDir, version);
    if (failedAt !== undefined) {
      refuse(
        `installing agent-chaperone@${version} failed at ${new Date(failedAt).toISOString()} ` +
          'and is retried ten minutes after that. Its error is in the hook output from then, ' +
          'and `npm install -g agent-chaperone` avoids the install altogether.',
      );
      return;
    }
    if (!(await install(dataDir, version))) {
      refuse(`could not install agent-chaperone@${version} into the plugin's data directory`);
      return;
    }
  }

  const direct = plan.kind === 'install' || plan.kind === 'installed';
  const child = spawn(
    direct ? process.execPath : plan.command,
    direct ? [plan.main, 'hook', side] : plan.args,
    {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: direct ? false : plan.shell,
      env: quietEnv(process.env),
    },
  );
  // A child that exits before reading everything closes the pipe under us. That
  // is not a failure: its exit code, which is the decision, arrives on close.
  child.stdin.on('error', (error) => error);
  child.stdin.end(input);

  const code = await finished(child);
  if (code === -1) {
    refuse(`could not start ${direct ? plan.main : plan.command}`);
    return;
  }
  process.exitCode = code;
}

await main();
