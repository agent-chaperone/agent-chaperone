#!/usr/bin/env node
/**
 * Minimal entry point: wrap an MCP server and relay its traffic.
 *
 * The full command set (log, show, approve, report, wrap) arrives with the
 * screens. For now this exists so the proxy can be run and tested the way a
 * client will actually invoke it.
 */

import { realpathSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createProxy } from '../proxy/proxy.js';
import { spawnUpstream, UpstreamStartError, type Upstream } from '../proxy/upstream.js';

const USAGE = `agent-chaperone: screen an MCP server's tool traffic.

  agent-chaperone -- <command> [args...]

Everything after -- is the upstream MCP server to run. Example:

  agent-chaperone -- npx -y @modelcontextprotocol/server-filesystem .

No screening happens yet; traffic is relayed unchanged.`;

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
}

/** Returns the upstream command, or undefined when the arguments do not name one. */
export function parseArguments(argv: readonly string[]): ParsedArguments | undefined {
  const separator = argv.indexOf('--');
  const rest = separator === -1 ? [...argv] : argv.slice(separator + 1);
  const [command, ...args] = rest;
  if (command === undefined || command.length === 0 || command.startsWith('-')) {
    return undefined;
  }
  return { command, args };
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

  let upstream: Upstream;
  try {
    upstream = spawnUpstream(parsed.command, parsed.args);
  } catch (error) {
    io.errorOutput.write(`${messageFor(error)}\n`);
    return EXIT_CANNOT_START;
  }

  // A framing failure ends the session. Without this the process would exit
  // zero having silently stopped relaying, which is the worst way for a
  // security tool to fail.
  let chaperoneFault = false;
  const proxy = createProxy(
    {
      clientInput: io.input,
      clientOutput: io.output,
      upstreamInput: upstream.stdin,
      upstreamOutput: upstream.stdout,
    },
    {
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
