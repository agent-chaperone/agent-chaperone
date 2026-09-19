/**
 * Rewriting a client's MCP configuration so its servers run behind the screen.
 *
 * The change is small and completely mechanical, which is exactly why it should
 * not be typed by hand into a file a client refuses to start without. Getting a
 * bracket wrong in that file breaks every server at once, and the error a client
 * gives for it rarely says so.
 *
 * Pure. Reading the file, backing it up and writing it are the caller's, so this
 * can be tested on shapes rather than on a filesystem.
 */

/** The binary a wrapped entry invokes. Global install is what the README documents. */
export const COMMAND = 'agent-chaperone';

export interface ServerEntry {
  readonly command?: unknown;
  readonly args?: unknown;
  readonly url?: unknown;
  readonly [key: string]: unknown;
}

export type Change =
  | { readonly kind: 'wrapped'; readonly name: string }
  | { readonly kind: 'unwrapped'; readonly name: string }
  | { readonly kind: 'already'; readonly name: string }
  | { readonly kind: 'skipped'; readonly name: string; readonly why: string };

export interface Rewrite {
  readonly config: Record<string, unknown>;
  readonly changes: readonly Change[];
}

/**
 * Where a client keeps its servers.
 *
 * Both spellings are in the wild, and a file may carry either. Anything else is
 * left alone rather than guessed at: a configuration this does not understand is
 * one it should not be editing.
 */
export const SECTIONS = ['mcpServers', 'servers'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Already going through the screen, whether invoked directly or through a runner. */
export function isWrapped(entry: ServerEntry): boolean {
  if (entry.command === COMMAND) {
    return true;
  }
  if (!Array.isArray(entry.args)) {
    return false;
  }
  // `npx -y agent-chaperone -- ...`, the form the README documents. Only what
  // sits before the separator counts: the upstream command after it may well be
  // called something similar, and that is not this.
  const separator = entry.args.indexOf('--');
  const before = separator === -1 ? entry.args : entry.args.slice(0, separator);
  return before.includes(COMMAND);
}

/**
 * The upstream an entry describes, as a command line.
 *
 * A URL entry becomes the URL, which the proxy takes in place of a command.
 */
function upstreamOf(entry: ServerEntry): string[] | undefined {
  if (typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url)) {
    return [entry.url];
  }
  if (typeof entry.command !== 'string' || entry.command.length === 0) {
    return undefined;
  }
  const args = Array.isArray(entry.args) ? entry.args.filter((one) => typeof one === 'string') : [];
  return [entry.command, ...(args as string[])];
}

function wrapEntry(name: string, entry: ServerEntry): ServerEntry {
  const upstream = upstreamOf(entry) ?? [];
  // `--server` names the policy section after the key in this file, so what
  // someone writes in their policy matches what they see in their client.
  const rest = Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== 'command' && key !== 'args' && key !== 'url'),
  );
  return { ...rest, command: COMMAND, args: ['--server', name, '--', ...upstream] };
}

function unwrapEntry(entry: ServerEntry): ServerEntry | undefined {
  const args = Array.isArray(entry.args) ? (entry.args as unknown[]) : [];
  const separator = args.indexOf('--');
  if (separator === -1) {
    return undefined;
  }
  const upstream = args.slice(separator + 1).filter((one) => typeof one === 'string') as string[];
  const [command, ...rest] = upstream;
  if (command === undefined) {
    return undefined;
  }
  const keep = Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== 'command' && key !== 'args'),
  );
  if (/^https?:\/\//i.test(command)) {
    return { ...keep, url: command };
  }
  return { ...keep, command, ...(rest.length === 0 ? {} : { args: rest }) };
}

/**
 * Put every server in a configuration behind the screen, or take them back out.
 *
 * Idempotent in both directions: an entry already in the wanted state is
 * reported and not touched, so running this twice is not a way to end up with
 * two layers of proxy or a mangled command line.
 */
export function rewrite(config: unknown, options: { readonly unwrap?: boolean } = {}): Rewrite {
  if (!isRecord(config)) {
    return { config: {}, changes: [] };
  }
  const out: Record<string, unknown> = { ...config };
  const changes: Change[] = [];

  for (const section of SECTIONS) {
    const servers = config[section];
    if (!isRecord(servers)) {
      continue;
    }
    const rewritten: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(servers)) {
      if (!isRecord(value)) {
        rewritten[name] = value;
        changes.push({ kind: 'skipped', name, why: 'it is not a server entry' });
        continue;
      }
      const entry = value as ServerEntry;
      const wrapped = isWrapped(entry);

      if (options.unwrap === true) {
        if (!wrapped) {
          rewritten[name] = value;
          changes.push({ kind: 'already', name });
          continue;
        }
        const bare = unwrapEntry(entry);
        if (bare === undefined) {
          rewritten[name] = value;
          changes.push({ kind: 'skipped', name, why: 'nothing recognisable to unwrap' });
          continue;
        }
        rewritten[name] = bare;
        changes.push({ kind: 'unwrapped', name });
        continue;
      }

      if (wrapped) {
        rewritten[name] = value;
        changes.push({ kind: 'already', name });
        continue;
      }
      if (upstreamOf(entry) === undefined) {
        // No command and no http URL. A transport this cannot reach is left
        // exactly as it is rather than rewritten into something that will not
        // start.
        rewritten[name] = value;
        changes.push({ kind: 'skipped', name, why: 'it names no command or http url' });
        continue;
      }
      rewritten[name] = wrapEntry(name, entry);
      changes.push({ kind: 'wrapped', name });
    }
    out[section] = rewritten;
  }

  return { config: out, changes };
}

export function formatChanges(changes: readonly Change[], unwrap: boolean): string {
  if (changes.length === 0) {
    return 'No servers found in that file. Nothing to change.';
  }
  const lines = changes.map((change) => {
    switch (change.kind) {
      case 'wrapped':
        return `  wrap     ${change.name}`;
      case 'unwrapped':
        return `  unwrap   ${change.name}`;
      case 'already':
        return `  leave    ${change.name} (already ${unwrap ? 'not wrapped' : 'wrapped'})`;
      default:
        return `  skip     ${change.name} (${change.why})`;
    }
  });
  const acted = changes.filter((one) => one.kind === 'wrapped' || one.kind === 'unwrapped').length;
  lines.push('');
  lines.push(
    acted === 0
      ? 'Nothing would change.'
      : `${acted} ${acted === 1 ? 'server' : 'servers'} would change.`,
  );
  return lines.join('\n');
}
