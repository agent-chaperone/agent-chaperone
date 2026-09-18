/**
 * Spawning the upstream MCP server.
 *
 * Its stderr is inherited rather than piped, so a server's own logging reaches
 * the user unchanged and the proxy never becomes a place where diagnostics go
 * to die.
 */

import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export class UpstreamStartError extends Error {
  constructor(command: string, cause: NodeJS.ErrnoException) {
    super(
      cause.code === 'ENOENT'
        ? `Could not start the upstream server: command not found: ${command}`
        : `Could not start the upstream server: ${command} (${cause.code ?? 'unknown error'})`,
    );
    this.name = 'UpstreamStartError';
  }
}

/**
 * The chaperone's own credentials, which belong to the chaperone and not to the
 * server it is policing.
 */
export const CHAPERONE_SECRETS = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY'];

/**
 * The environment to hand the upstream: everything the client gave us, minus
 * the keys this program uses to reach its model backend. The client's own
 * environment is what it meant for the server, so it passes through; handing a
 * screened process the credentials of the thing screening it does not.
 */
export function environmentForUpstream(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const withheld = new Set<string>(CHAPERONE_SECRETS);
  return Object.fromEntries(Object.entries(source).filter(([name]) => !withheld.has(name)));
}

export interface Upstream {
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Resolves with the exit code, or 1 when the process was killed by a signal. */
  readonly exited: Promise<number>;
  kill(): void;
}

export function spawnUpstream(command: string, args: readonly string[]): Upstream {
  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: environmentForUpstream(),
  });

  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(new UpstreamStartError(command, error));
    });
    child.once('close', (code, signal) => {
      resolve(code ?? (signal !== null ? 1 : 0));
    });
  });

  if (child.stdin === null || child.stdout === null) {
    throw new Error('The upstream server was started without usable standard streams');
  }

  // The proxy attaches its own handlers a moment later, but a child that dies
  // between spawn and that moment would otherwise raise an unhandled error on
  // these pipes and take the process down with it.
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    exited,
    kill(): void {
      child.kill();
    },
  };
}
