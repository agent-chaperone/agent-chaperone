/**
 * Shell forms that are dangerous on their face.
 *
 * This is not a sandbox and it is not a substitute for the judgment that
 * follows. It catches the handful of commands whose meaning is not in doubt, so
 * that something useful happens with no API key configured, and so the audit
 * log can name what matched rather than only reporting a probability.
 *
 * Every pattern is a bounded scan with no nested quantifier.
 */

export interface DangerousPattern {
  readonly name: string;
  readonly what: string;
  readonly pattern: RegExp;
}

export const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  {
    name: 'recursive-delete-of-root',
    what: 'deletes a root or home directory recursively',
    pattern:
      /\brm\s+(?:-{1,2}[a-zA-Z-]{1,20}\s+){0,5}(?:-{1,2}[a-zA-Z-]{0,20}[rR][a-zA-Z-]{0,20}|--recursive)\s+(?:-{1,2}[a-zA-Z-]{1,20}\s+){0,5}['"]?(?:\/|~\/?|\$HOME\/?|\/\*)['"]?(?:\s|$)/,
  },
  {
    name: 'pipe-remote-script-to-shell',
    what: 'runs a script fetched from the network',
    pattern: /\b(?:curl|wget|fetch)\b[^|;]{0,400}\|\s{0,8}(?:sudo\s{1,4}){0,1}(?:ba|z|k|da)?sh\b/,
  },
  {
    name: 'overwrite-block-device',
    what: 'writes directly to a block device',
    pattern: /\bdd\b[^;&|]{0,200}\bof=\/dev\/(?:sd|nvme|disk|hd)/,
  },
  {
    name: 'format-filesystem',
    what: 'formats a filesystem',
    pattern: /\bmkfs(?:\.[a-z0-9]{1,10})?\b/,
  },
  {
    name: 'world-writable-root',
    what: 'makes a system directory world writable',
    pattern: /\bchmod\s+(?:-[a-zA-Z]{1,8}\s+){0,3}(?:0?777|a\+rwx)\s+\/(?:\s|$)/,
  },
  {
    name: 'force-push',
    what: 'rewrites published history',
    pattern: /\bgit\s+push\b[^;&|]{0,200}(?:--force\b(?!-with-lease)|\s-f\b)/,
  },
  {
    name: 'discard-local-history',
    what: 'discards local history or untracked work',
    // -n is a dry run, so a flag group containing it is not destructive.
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+(?!-[a-zA-Z]{0,6}n)-[a-zA-Z]{0,6}[fdx])/,
  },
  {
    name: 'clear-shell-history',
    what: 'erases the record of what was run',
    pattern: /\bhistory\s+-c\b|\brm\b[^;&|]{0,80}\.(?:bash|zsh)_history\b/,
  },
  {
    name: 'fork-bomb',
    what: 'exhausts the process table',
    pattern: /:\s*\(\s*\)\s*\{[^}]{0,40}\|[^}]{0,40}&\s*\}\s*;\s*:/,
  },
  {
    name: 'disable-firewall',
    what: 'turns off a host firewall',
    pattern: /\b(?:ufw\s+disable|iptables\s+-F|systemctl\s+stop\s+firewalld|pfctl\s+-d)\b/,
  },
  {
    name: 'remote-shell-listener',
    what: 'opens a shell to a remote host',
    // Anchored on the two forms that do it. The previous shape matched any `nc`
    // near any flag containing an e, which is most of them.
    pattern:
      /\bnc\s(?:[^;&|]{0,80}\s)?-[a-zA-Z]{0,6}e[a-zA-Z]{0,6}\s{1,4}\/(?:bin|usr)\/|\b(?:ba|z|k)?sh\s{1,4}-i\s{0,4}>&\s{0,4}\/dev\/tcp\//,
  },
  {
    name: 'destroy-cluster-namespace',
    what: 'deletes a cluster namespace',
    // A trailing word boundary alone matched `ns-anything`, an ordinary name.
    pattern: /\bkubectl\s+delete\s+(?:ns|namespaces?)(?:\s|$)/,
  },
];

export interface DangerousMatch {
  readonly name: string;
  readonly what: string;
  /** The text that matched, so the audit log can show it. */
  readonly excerpt: string;
}

/** Every dangerous form in the command, in the order the patterns are declared. */
export function findDangerousForms(command: string): readonly DangerousMatch[] {
  const found: DangerousMatch[] = [];
  for (const { name, what, pattern } of DANGEROUS_PATTERNS) {
    const match = pattern.exec(command);
    if (match !== null) {
      found.push({ name, what, excerpt: match[0].slice(0, 120) });
    }
  }
  return found;
}

/** Deeper than any real tool argument, and shallow enough to recurse safely. */
export const MAX_ARGUMENT_DEPTH = 64;

/** The total text one call will scan, which is the bound that matters for cost. */
export const MAX_SCAN_CHARS = 1_000_000;

/**
 * Every string anywhere in a JSON value, so arguments are scanned wherever the
 * command sits.
 *
 * Bounded by total characters rather than by count. A limit on the number of
 * strings is trivially defeated by putting everything in one of them, and it is
 * the characters that the dangerous-form patterns then read.
 */
export function collectStrings(value: unknown, maxChars = MAX_SCAN_CHARS): readonly string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  let budget = maxChars;

  const walk = (input: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_ARGUMENT_DEPTH) {
      return;
    }
    if (typeof input === 'string') {
      const piece = input.length > budget ? input.slice(0, budget) : input;
      budget -= piece.length;
      out.push(piece);
      return;
    }
    if (typeof input !== 'object' || input === null || seen.has(input)) {
      return;
    }
    seen.add(input);
    for (const nested of Array.isArray(input) ? input : Object.values(input)) {
      walk(nested, depth + 1);
    }
  };

  walk(value, 0);
  return out;
}
