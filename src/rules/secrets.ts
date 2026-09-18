/**
 * Finding and replacing secret-shaped strings.
 *
 * This runs before anything leaves the process, in both directions: a
 * credential in a tool's arguments should not travel to the model backend, and
 * one in a result should not be written to the audit log. Redaction also
 * sharpens the judgment that follows, because the model is asked whether a
 * secret is present, not what it is.
 *
 * Two rules govern every pattern here, and breaking either one has cost real
 * time already.
 *
 * A pattern must not open a start position it then scans far from. `\b` before
 * a class that contains `-` does exactly that: on a long run of `-eyJ` the
 * engine begins a match at every dash and reads thousands of characters before
 * failing, which is quadratic. Use a negative lookbehind over the same class.
 *
 * A pattern must match the credential, not the identifier beside it. An AWS
 * access key id is public; the secret access key next to it is the one that
 * grants access.
 */

/** The names a policy file may list under `redaction.patterns`. */
export const SECRET_KINDS = [
  'aws_key',
  'github_token',
  'private_key',
  'jwt',
  'slack_token',
  'bearer_token',
  'connection_string',
  'generic_api_key',
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretPattern {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
}

/** Long enough for any credential a service actually issues, short of scanning a whole document. */
const VALUE = '[A-Za-z0-9_\\-./+=]{16,4096}';

/** Field names whose value is the thing that grants access, not the thing that names it. */
const SECRET_FIELD =
  // `secret[_-]?(?:access[_-]?)?key` already covers aws_secret_access_key, so
  // there is no separate alternative for it.
  '(?:secret[_-]?(?:access[_-]?)?key|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?token|passwd|password)';

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'aws_key', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  {
    kind: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  { kind: 'private_key', pattern: /-----BEGIN (?:[A-Z]{1,20} ){0,4}PRIVATE KEY-----/g },
  {
    kind: 'jwt',
    // Lookbehind rather than \b: see the note above about start positions.
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,4096}\.eyJ[A-Za-z0-9_-]{4,4096}\.[A-Za-z0-9_-]{4,4096}/g,
  },
  { kind: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g },
  {
    kind: 'bearer_token',
    // The header form, which carries the credential with no field name at all.
    pattern: new RegExp(`(?<![A-Za-z0-9_-])[Bb]earer\\s{1,4}(${VALUE})`, 'g'),
  },
  {
    kind: 'connection_string',
    // The password inside a URL. Only the password is replaced, so the host and
    // database still read sensibly in the audit log.
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:([^\s@/]{4,256})@/gi,
  },
  {
    kind: 'generic_api_key',
    // A named field assigned a long opaque value. The separator classes cannot
    // overlap, so there is nothing for the engine to backtrack over.
    pattern: new RegExp(`${SECRET_FIELD}["' ]{0,4}[:=]["' ]{0,4}(${VALUE})`, 'gi'),
  },
];

export interface SecretMatch {
  readonly kind: SecretKind;
  readonly start: number;
  readonly end: number;
}

/** A bound on how many matches one scan will record, so a hostile input cannot exhaust memory. */
export const MAX_MATCHES = 10_000;

/** The replacement a redacted secret leaves behind, which says what was removed. */
export function placeholder(kind: SecretKind): string {
  return `[REDACTED:${kind}]`;
}

/**
 * Every secret-shaped run in the text, earliest first, with overlaps merged.
 *
 * A later match that reaches past an earlier one extends it rather than being
 * discarded. Discarding it left the tail of the longer secret in cleartext.
 */
export function findSecrets(
  text: string,
  kinds: readonly SecretKind[] = SECRET_KINDS,
): readonly SecretMatch[] {
  const wanted = new Set<SecretKind>(kinds);
  const found: SecretMatch[] = [];

  for (const { kind, pattern } of SECRET_PATTERNS) {
    // Checked before each pattern as well as after each match. Breaking only the
    // inner loop let every later pattern add one more match past the cap, so the
    // bound was not a bound and what it cut off depended on pattern order.
    if (found.length >= MAX_MATCHES) {
      break;
    }
    if (!wanted.has(kind)) {
      continue;
    }
    // A fresh expression per call: a shared one carries lastIndex between calls.
    const scanner = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(scanner)) {
      const value = match[1] ?? match[0];
      const start = match.index + (match[1] === undefined ? 0 : match[0].indexOf(match[1]));
      found.push({ kind, start, end: start + value.length });
      if (found.length >= MAX_MATCHES) {
        break;
      }
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: SecretMatch[] = [];
  for (const match of found) {
    const previous = kept[kept.length - 1];
    if (previous === undefined || match.start >= previous.end) {
      kept.push(match);
    } else if (match.end > previous.end) {
      kept[kept.length - 1] = { kind: previous.kind, start: previous.start, end: match.end };
    }
  }
  return kept;
}

/** The text with every secret-shaped run replaced by a placeholder naming its kind. */
export function redactText(
  text: string,
  kinds?: readonly SecretKind[],
): { readonly text: string; readonly secrets: readonly SecretMatch[] } {
  const secrets = findSecrets(text, kinds);
  if (secrets.length === 0) {
    return { text, secrets };
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const secret of secrets) {
    parts.push(text.slice(cursor, secret.start), placeholder(secret.kind));
    cursor = secret.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), secrets };
}

/** Deeper than any real tool argument, and shallow enough to recurse safely. */
export const MAX_JSON_DEPTH = 64;

/**
 * The same over any JSON value, so a credential nested in a tool's arguments is
 * caught wherever it sits.
 *
 * It reports the kinds it replaced rather than positions, because an offset
 * into one nested string means nothing to a reader of the audit log, and the
 * string it indexed is not what any caller receives.
 */
export function redactJson(
  value: unknown,
  kinds?: readonly SecretKind[],
): { readonly value: unknown; readonly secrets: readonly SecretKind[] } {
  const secrets: SecretKind[] = [];
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) {
      return '[UNSCANNED:too-deep]';
    }
    if (typeof input === 'string') {
      const result = redactText(input, kinds);
      for (const secret of result.secrets) {
        secrets.push(secret.kind);
      }
      return result.text;
    }
    if (typeof input !== 'object' || input === null) {
      return input;
    }
    // A value that refers back to itself would otherwise recurse forever.
    if (seen.has(input)) {
      return '[UNSCANNED:circular]';
    }
    seen.add(input);

    if (Array.isArray(input)) {
      return input.map((item) => walk(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input)) {
      const redactedKey = redactText(key, kinds);
      for (const secret of redactedKey.secrets) {
        secrets.push(secret.kind);
      }
      // defineProperty rather than assignment, so a key of `__proto__` becomes
      // an ordinary property instead of silently setting the prototype, and a
      // suffix when two keys redact to the same placeholder, so neither is lost.
      let name = redactedKey.text;
      for (let n = 2; Object.hasOwn(out, name); n += 1) {
        name = `${redactedKey.text}#${n}`;
      }
      Object.defineProperty(out, name, {
        value: walk(nested, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };

  return { value: walk(value, 0), secrets };
}
