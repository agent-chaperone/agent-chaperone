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
import {
  createAuditLog,
  findRecord,
  followRecords,
  formatRecord,
  recentRecords,
} from '../audit/index.js';
import { grantApproval, readHold, sweepApprovals } from '../approvals/index.js';
import { sanitizeMessage } from '../backends/index.js';
import { createTypeSafeBackend, hasTypeSafeKey } from '../backends/index.js';
import { PolicyError, parsePolicy, type Policy } from '../policy/index.js';
import { createProxy } from '../proxy/proxy.js';
import { spawnUpstream, UpstreamStartError, type Upstream } from '../proxy/upstream.js';
import { createScreeningGate, type Judgment } from '../screening/index.js';

const USAGE = `agent-chaperone: screen an MCP server's tool traffic.

  agent-chaperone [options] -- <command> [args...]   Wrap and screen a server
  agent-chaperone log [--follow]                     Read this session's decisions
  agent-chaperone show <id>                          Print what was held or withheld
  agent-chaperone approve <id>                       Let one held call through, once

Everything after -- is the upstream MCP server to run. Example:

  agent-chaperone -- npx -y @modelcontextprotocol/server-filesystem .

Options:
  --policy <path>       Policy file. Default: ~/.config/agent-chaperone/policy.yaml
  --server <name>       Which section of the policy applies. Default: the command name
  --no-store-content    Record the judgments and not the arguments or results

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
  readonly storeContent: boolean;
}

/** What the arguments asked for. */
export type Command =
  | ({ readonly kind: 'wrap' } & ParsedArguments)
  | { readonly kind: 'log'; readonly follow: boolean }
  | { readonly kind: 'show'; readonly id: string }
  | { readonly kind: 'approve'; readonly id: string }
  | { readonly kind: 'usage' };

/**
 * The subcommand, or the wrap form.
 *
 * A bare name is a subcommand; anything else is the server to wrap. The wrap
 * form has no verb because it is what a client's configuration file invokes, and
 * that line is written once and read by people who did not write it.
 */
export function parseCommand(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === 'log') {
    return { kind: 'log', follow: rest.includes('--follow') || rest.includes('-f') };
  }
  if (first === 'show' || first === 'approve') {
    const id = rest.find((one) => !one.startsWith('-'));
    return id === undefined ? { kind: 'usage' } : { kind: first, id };
  }
  const parsed = parseArguments(argv);
  return parsed === undefined ? { kind: 'usage' } : { kind: 'wrap', ...parsed };
}

/** Returns the upstream command and our own options, or undefined when no command is named. */
export function parseArguments(argv: readonly string[]): ParsedArguments | undefined {
  const separator = argv.indexOf('--');
  const ours = separator === -1 ? [] : argv.slice(0, separator);
  const rest = separator === -1 ? [...argv] : argv.slice(separator + 1);

  let policyPath: string | undefined;
  let server: string | undefined;
  let storeContent = true;
  for (let at = 0; at < ours.length; at += 1) {
    const flag = ours[at];
    const value = ours[at + 1];
    if (flag === '--policy' && value !== undefined) {
      policyPath = value;
      at += 1;
    } else if (flag === '--server' && value !== undefined) {
      server = value;
      at += 1;
    } else if (flag === '--no-store-content') {
      storeContent = false;
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
    storeContent,
    ...(policyPath === undefined ? {} : { policyPath }),
    ...(server === undefined ? {} : { server }),
  };
}

export function defaultPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  // An empty value means unset, or the default policy path would be relative and
  // a policy the user wrote would silently not be found.
  const base = env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
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

/**
 * `log`: what this session decided, one line each.
 *
 * Shadow mode is the default and blocks nothing, so this is the only place a
 * user sees it working. The decision column says what was done and, when they
 * differ, what the policy would have done instead, which is the comparison a
 * threshold is chosen from.
 */
export function runLog(io: RunStreams, env: NodeJS.ProcessEnv = process.env): number {
  const records = recentRecords(undefined, env);
  if (records.length === 0) {
    io.errorOutput.write('agent-chaperone: nothing has been screened yet.\n');
    return 0;
  }
  io.output.write(records.map((record) => `${formatRecord(record)}\n`).join(''));
  return 0;
}

/** `log --follow`: the same lines, and then whatever happens next. */
export async function runFollow(
  io: RunStreams,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  await followRecords((record) => io.output.write(`${formatRecord(record)}\n`), { signal, env });
  return 0;
}

/**
 * Text on its way to a terminal, with anything that could move a cursor removed.
 *
 * `sanitizeMessage` is the wrong instrument for a whole result: it collapses
 * whitespace and cuts at 200 characters, and this is the copy a user asked to
 * read in full. Line breaks stay; everything that is not a line break goes.
 */
function scrubForTerminal(text: string): string {
  return text
    .split('\n')
    .map((line) => sanitizeMessage(line))
    .join('\n');
}

/** `show`: what was actually held or withheld, which the agent was not given. */
export function runShow(id: string, io: RunStreams, env: NodeJS.ProcessEnv = process.env): number {
  const record = findRecord(id, env);
  if (record === undefined) {
    io.errorOutput.write(`agent-chaperone: no record with id ${id}.\n`);
    return EXIT_USAGE;
  }
  if (record.content === undefined) {
    io.output.write(`${formatRecord(record)}\n`);
    io.errorOutput.write(
      'agent-chaperone: this session recorded judgments only, so there is nothing to show.\n',
    );
    return 0;
  }
  const body =
    record.kind === 'result'
      ? record.content.text
      : JSON.stringify(record.content.arguments, null, 2);
  // Printed to a terminal, and withheld in the first place because something in
  // it was addressed to whoever reads it. Control characters come out.
  io.output.write(`${formatRecord(record)}\n\n${scrubForTerminal(body ?? '')}\n`);
  return 0;
}

/**
 * `approve`: let one held call through, once.
 *
 * The token names the exact call, not the tool, so agreeing to a write to one
 * path does not release a write to another. A deny list is not approvable: that
 * is a standing rule the user wrote, and this releases a call they were asked
 * about.
 */
export function runApprove(
  id: string,
  io: RunStreams,
  env: NodeJS.ProcessEnv = process.env,
): number {
  sweepApprovals({ env });
  const hold = readHold(id, { env });
  if (hold === undefined) {
    // The audit log is consulted only to say something better than "unknown".
    // It is not what decides: a hold is, so this works when content was not
    // stored and when the log could not be written at all.
    io.errorOutput.write(`agent-chaperone: ${explainMissingHold(id, env)}\n`);
    return EXIT_USAGE;
  }

  const approval = grantApproval(hold, { env });
  if (approval === undefined) {
    io.errorOutput.write(`agent-chaperone: ${id} could not be allowed.\n`);
    return EXIT_USAGE;
  }
  io.output.write(
    `Allowed once: ${hold.tool}. Ask the agent to try again before ${approval.expiresAt.slice(11, 19)}Z. A second attempt after that is held again.\n`,
  );
  return 0;
}

/** Why there is no hold for this id, in whatever detail the log can supply. */
function explainMissingHold(id: string, env: NodeJS.ProcessEnv): string {
  const record = findRecord(id, env);
  if (record === undefined) {
    return `no held call with id ${id}.`;
  }
  if (record.kind !== 'call') {
    return `${id} is a tool result, not a call, so there is nothing to allow. Use agent-chaperone show ${id} to read it.`;
  }
  const applied = record.applied as { kind?: string } | undefined;
  if (applied?.kind === 'block') {
    return `${id} was blocked by the policy rather than held, so approving it would not change anything. Edit the policy file instead.`;
  }
  if (applied?.kind !== 'hold') {
    return `${id} was ${String(applied?.kind ?? 'not held')}, so there is nothing to allow.`;
  }
  return `the hold for ${id} has expired. Ask the agent to try the call again, and approve the new id.`;
}

export async function run(
  argv: readonly string[],
  io: RunStreams = { input: process.stdin, output: process.stdout, errorOutput: process.stderr },
  options: RunOptions = {},
): Promise<number> {
  const asked = parseCommand(argv);
  if (asked.kind === 'usage') {
    io.errorOutput.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (asked.kind === 'log') {
    if (!asked.follow) {
      return runLog(io);
    }
    const stop = new AbortController();
    const onSignal = (): void => stop.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      return await runFollow(io, stop.signal);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
  if (asked.kind === 'show') {
    return runShow(asked.id, io);
  }
  if (asked.kind === 'approve') {
    return runApprove(asked.id, io);
  }
  const parsed = asked;

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
  const audit = createAuditLog({
    storeContent: parsed.storeContent,
    onProblem: (message) => io.errorOutput.write(`agent-chaperone: ${message}\n`),
  });
  const gate = createScreeningGate({
    policy,
    server,
    ...(backend === undefined ? {} : { backend }),
    onJudgment: (judgment: Judgment) => audit.write(judgment),
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
