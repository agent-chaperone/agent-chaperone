#!/usr/bin/env node
/**
 * Entry point: wrap an MCP server and screen its traffic.
 *
 * The rest of the command set (log, show, approve, report, wrap) arrives with
 * the audit log and the approve flow. This is the part that puts the screens in
 * the path of a real session.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createTypeSafeBackend, hasTypeSafeKey } from '../backends/index.js';
import { PolicyError, parsePolicy, type Policy } from '../policy/index.js';
import { createProxy } from '../proxy/proxy.js';
import { spawnUpstream, UpstreamStartError, type Upstream } from '../proxy/upstream.js';
import { createScreeningGate, type Judgment } from '../screening/index.js';

const USAGE = `agent-chaperone: screen an MCP server's tool traffic.

  agent-chaperone [options] -- <command> [args...]

Everything after -- is the upstream MCP server to run. Example:

  agent-chaperone -- npx -y @modelcontextprotocol/server-filesystem .

Options:
  --policy <path>   Policy file. Default: ~/.config/agent-chaperone/policy.yaml
  --server <name>   Which section of the policy applies. Default: the command name

Screening needs TYPESAFE_API_KEY. Without it the deterministic rules still run,
which is allow and deny lists, and every judgment says no model was asked.
The default mode is shadow: everything is screened, nothing is blocked.`;

/** How long an upstream gets to exit on its own after the client disconnects. */
export const DEFAULT_GRACE_MS = 2000;

/** Exit code when the chaperone itself ended the session, rather than the upstream. */
const EXIT_CHAPERONE_FAULT = 70;
const EXIT_USAGE = 64;
const EXIT_CANNOT_START = 127;

export interface RunStreams {
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
}

export interface RunOptions {
  readonly graceMs?: number;
}

export interface ParsedArguments {
  readonly command: string;
  readonly args: readonly string[];
  readonly policyPath?: string;
  readonly server?: string;
}

/** Returns the upstream command and our own options, or undefined when no command is named. */
export function parseArguments(argv: readonly string[]): ParsedArguments | undefined {
  const separator = argv.indexOf('--');
  const ours = separator === -1 ? [] : argv.slice(0, separator);
  const rest = separator === -1 ? [...argv] : argv.slice(separator + 1);

  let policyPath: string | undefined;
  let server: string | undefined;
  for (let at = 0; at < ours.length; at += 1) {
    const flag = ours[at];
    const value = ours[at + 1];
    if (flag === '--policy' && value !== undefined) {
      policyPath = value;
      at += 1;
    } else if (flag === '--server' && value !== undefined) {
      server = value;
      at += 1;
    } else {
      return undefined;
    }
  }

  const [command, ...args] = rest;
  if (command === undefined || command.length === 0 || command.startsWith('-')) {
    return undefined;
  }
  return {
    command,
    args,
    ...(policyPath === undefined ? {} : { policyPath }),
    ...(server === undefined ? {} : { server }),
  };
}

export function defaultPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'agent-chaperone', 'policy.yaml');
}

/**
 * The policy, or the defaults when no file has been written yet.
 *
 * A file that exists but does not parse stops the session. Running on a policy
 * nobody could read would mean enforcing something other than what the user
 * wrote, which is worse than refusing to start.
 */
export function loadPolicy(path: string): Policy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return parsePolicy('');
  }
  return parsePolicy(text);
}

/**
 * Wait for the upstream to exit, then stop waiting.
 *
 * Closing its input is a request, not a guarantee. A server that ignores end of
 * input would otherwise keep this process alive forever and leave itself
 * running unsupervised, so it gets a grace period and then a signal.
 */
export async function settleUpstream(
  upstream: Upstream,
  graceMs: number = DEFAULT_GRACE_MS,
): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), graceMs);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([upstream.exited, grace]);
    if (outcome !== 'expired') {
      return outcome;
    }
    upstream.kill();
    return await upstream.exited;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function run(
  argv: readonly string[],
  io: RunStreams = { input: process.stdin, output: process.stdout, errorOutput: process.stderr },
  options: RunOptions = {},
): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed === undefined) {
    io.errorOutput.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }

  const policyPath = parsed.policyPath ?? defaultPolicyPath();
  let policy: Policy;
  try {
    policy = loadPolicy(policyPath);
  } catch (error) {
    const detail = error instanceof PolicyError ? error.message : messageFor(error);
    io.errorOutput.write(`agent-chaperone: ${policyPath} could not be read: ${detail}\n`);
    return EXIT_USAGE;
  }

  let upstream: Upstream;
  try {
    upstream = spawnUpstream(parsed.command, parsed.args);
  } catch (error) {
    io.errorOutput.write(`${messageFor(error)}\n`);
    return EXIT_CANNOT_START;
  }

  // Said once the session is actually going to happen, so a command that could
  // not start reports that rather than something about configuration.
  const server = parsed.server ?? basename(parsed.command);
  const backend = hasTypeSafeKey() ? createTypeSafeBackend() : undefined;
  if (backend === undefined) {
    io.errorOutput.write(
      'agent-chaperone: TYPESAFE_API_KEY is not set, so only the deterministic rules will run.\n',
    );
  }

  // A framing failure ends the session. Without this the process would exit
  // zero having silently stopped relaying, which is the worst way for a
  // security tool to fail.
  let chaperoneFault = false;
  // Until the audit log lands, a judgment goes to stderr as one JSON line. That
  // is where a client shows server diagnostics, and it keeps shadow mode useful
  // in the meantime, which is the only mode that ships on by default.
  const gate = createScreeningGate({
    policy,
    server,
    ...(backend === undefined ? {} : { backend }),
    onJudgment: (judgment: Judgment) => {
      io.errorOutput.write(`${JSON.stringify(judgment)}\n`);
    },
  });
  const proxy = createProxy(
    {
      clientInput: io.input,
      clientOutput: io.output,
      upstreamInput: upstream.stdin,
      upstreamOutput: upstream.stdout,
    },
    {
      gate,
      onEvent: (event) => {
        if (event.type === 'stream-error') {
          chaperoneFault = true;
          io.errorOutput.write(`agent-chaperone: ${event.error.message}\n`);
        }
      },
    },
  );

  // Take the server down with us rather than orphaning it.
  const stopUpstream = (): void => upstream.kill();
  process.on('SIGINT', stopUpstream);
  process.on('SIGTERM', stopUpstream);

  // The client going away is its own shutdown trigger. Waiting only on the
  // relay would hang forever against a server that ignores the end of its
  // input, because nothing would ever close its output.
  const clientGone = new Promise<void>((resolve) => {
    io.input.once('end', () => resolve());
    io.input.once('close', () => resolve());
  });

  try {
    await Promise.race([proxy.closed, upstream.exited, clientGone]);
    const code = await settleUpstream(upstream, options.graceMs);
    proxy.close();
    return chaperoneFault ? EXIT_CHAPERONE_FAULT : code;
  } catch (error) {
    proxy.close();
    io.errorOutput.write(`${messageFor(error)}\n`);
    return EXIT_CANNOT_START;
  } finally {
    process.off('SIGINT', stopUpstream);
    process.off('SIGTERM', stopUpstream);
  }
}

function messageFor(error: unknown): string {
  if (error instanceof UpstreamStartError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when this file is the program being run, rather than imported.
 *
 * Paths are resolved through symlinks because an installed package is invoked
 * through a shim in `node_modules/.bin`. Comparing raw paths would miss that
 * and the command would silently do nothing.
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${messageFor(error)}\n`);
      process.exitCode = EXIT_CHAPERONE_FAULT;
    });
}
