import { describe, expect, it } from 'vitest';
import { SECRET_KINDS, findSecrets, placeholder, redactJson, redactText } from './secrets.js';

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const GITHUB = `ghp_${'a'.repeat(36)}`;
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const SLACK = 'xoxb-123456789012-abcdefghijklmnop';
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----';
const PROVIDER = `sk-ant-api03-${'A'.repeat(60)}`;

describe('finding each kind', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['aws_key', `id=${AWS}`],
    ['github_token', `token ${GITHUB}`],
    ['private_key', `${PRIVATE_KEY}\nMIIE...`],
    ['jwt', `authorization: Bearer ${JWT}`],
    ['slack_token', `slack ${SLACK}`],
    ['generic_api_key', 'api_key = "s3cret_value_that_is_long"'],
    ['bearer_token', 'Authorization: Bearer abcdefghijklmnop1234567890'],
    ['connection_string', 'postgres://admin:sup3rS3cretPw@db.internal:5432/prod'],
    ['provider_key', `using ${PROVIDER} now`],
  ];

  for (const [kind, text] of cases) {
    it(`finds ${kind}`, () => {
      expect(findSecrets(text).map((s) => s.kind)).toContain(kind);
    });
  }

  it('covers every kind the policy file may name', () => {
    const found = new Set(cases.map(([kind]) => kind));
    expect([...SECRET_KINDS].sort()).toEqual([...found].sort());
  });
});

describe('not firing on ordinary text', () => {
  it('leaves prose, paths and identifiers alone', () => {
    for (const text of [
      'The quick brown fox jumps over the lazy dog, repeatedly and at length.',
      '/Users/someone/projects/agent-chaperone/src/rules/secrets.ts',
      'commit a1b2c3d4e5f6 by someone on a Tuesday',
      'AKIA is a prefix but this is not a key',
      'ghp_tooShort',
      // A documented prefix is only a credential with the issuer's own run
      // behind it. These are the shapes that would be redacted as secrets if
      // the patterns guessed rather than pinning each issuer's format.
      'sk-short',
      'the sdk-version is 2',
      'ask-the-user-before-running-this-command-please',
      'AIzaTooShortToBeAGoogleKey',
      'npm_install_is_not_a_token',
      'commit 0123456789abcdef0123456789abcdef01234567 landed',
      'sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
    ]) {
      expect(findSecrets(text)).toEqual([]);
    }
  });

  it('finds a credential that carries its own prefix, wherever it sits', () => {
    // `generic_api_key` only matches next to a field name it recognises, so
    // these three all went through untouched: in prose, under a JSON key this
    // file has never heard of, and on its own.
    for (const text of [PROVIDER, `{"key": "${PROVIDER}"}`, `using ${PROVIDER} now`]) {
      expect(redactText(text).text).not.toContain(PROVIDER);
    }
  });

  it.each([['sk-svcacct-'], ['sk-admin-'], ['sk-proj-'], ['sk-ant-api03-'], ['sk-']])(
    'covers the %s prefix its issuer documents',
    (prefix) => {
      // The bare `sk-` run cannot reach past a dash, so a named sub-prefix needs
      // its own alternative or it matches nothing at all.
      const key = `${prefix}${'A'.repeat(156)}`;
      expect(findSecrets(`export KEY of ${key} for the run`).map((one) => one.kind)).toContain(
        'provider_key',
      );
    },
  );

  it('redacts an over-long key whole rather than leaving a tail', () => {
    // A bound shorter than the run means the head is replaced and the rest is
    // still there, which reads as redacted and is not.
    const long = `sk-${'A'.repeat(600)}`;
    expect(redactText(long).text).not.toContain('AAAA');
  });

  it('finds a credential named by its key rather than by the string it sits in', () => {
    // Tool arguments arrive structured, so the field name is a JSON key and the
    // value is scanned on its own. The field-name pattern never saw the two
    // together, which made this the ordinary shape rather than an edge case.
    const redacted = redactJson({ headers: { api_key: 'AAAABBBBCCCCDDDDEEEEFFFF' } });
    expect(JSON.stringify(redacted.value)).not.toContain('AAAABBBBCCCCDDDDEEEEFFFF');
    expect(redacted.secrets).toContain('generic_api_key');
  });

  it('leaves a key whose value reads as prose alone', () => {
    const redacted = redactJson({ description: 'the api_key is rotated every quarter' });
    expect(redacted.secrets).toEqual([]);
  });

  it('still finds a prefixed credential in text padded with cheaper matches', () => {
    // The match cap is spent in pattern order and skips whole patterns once it
    // is reached, so whichever pattern sits last is the first to be starved.
    const filler = Array.from(
      { length: 10_500 },
      (_, at) => `AKIAIOSFODNN7EXAMP${String.fromCharCode(65 + (at % 26))}`,
    ).join(' ');
    const key = `sk-ant-api03-${'A'.repeat(95)}`;
    expect(redactText(`${filler}\nmy key is ${key}`).text).not.toContain(key);
  });

  it('does not match a prefix that follows a dash', () => {
    // A word boundary would allow this: the dash is a non-word character, so
    // `\b` opens a match right after it. The lookbehind is over the same class
    // the run uses, which is what makes a buried shape stay buried.
    expect(findSecrets(`x-sk-${'A'.repeat(40)}`)).toEqual([]);
  });

  it('does not match a prefix buried inside a longer token', () => {
    // The rule the file already keeps: a hash that happens to contain a
    // credential shape is a hash, not a credential.
    expect(findSecrets(`x1234${PROVIDER}`)).toEqual([]);
  });
});

describe('redactText', () => {
  it('replaces the secret with a placeholder that names its kind', () => {
    expect(redactText(`key=${AWS}`).text).toBe(`key=${placeholder('aws_key')}`);
  });

  it('replaces several secrets in one string', () => {
    const redacted = redactText(`a ${AWS} b ${GITHUB} c`).text;
    expect(redacted).toBe(`a ${placeholder('aws_key')} b ${placeholder('github_token')} c`);
  });

  it('returns the text untouched when there is nothing to redact', () => {
    const text = 'nothing to see';
    expect(redactText(text).text).toBe(text);
  });

  it('redacts only the kinds it was asked for', () => {
    const both = `${AWS} ${GITHUB}`;
    expect(redactText(both, ['aws_key']).text).toContain(GITHUB);
    expect(redactText(both, ['aws_key']).text).not.toContain(AWS);
  });

  it('redacts nothing when asked for nothing, rather than everything', () => {
    expect(redactText(`${AWS}`, []).text).toBe(AWS);
  });

  it('reports where each secret was', () => {
    const [match] = findSecrets(`prefix ${AWS}`);
    expect(match?.start).toBe(7);
    expect(match?.end).toBe(7 + AWS.length);
  });

  it('does not emit overlapping replacements when two patterns match the same run', () => {
    const text = `api_key = "${GITHUB}"`;
    const redacted = redactText(text).text;
    expect(redacted).not.toContain(GITHUB);
    expect(redacted.match(/\[REDACTED:/g)).toHaveLength(1);
  });
});

describe('redactJson', () => {
  it('reaches a secret nested in an object and an array', () => {
    const { value, secrets } = redactJson({ a: [{ b: `x ${AWS}` }], c: 'clean' });
    expect(JSON.stringify(value)).not.toContain(AWS);
    expect(JSON.stringify(value)).toContain('clean');
    expect(secrets).toHaveLength(1);
  });

  it('redacts a secret used as a key, not only as a value', () => {
    const { value } = redactJson({ [GITHUB]: 'value' });
    expect(Object.keys(value as object)[0]).toBe(placeholder('github_token'));
  });

  it('leaves numbers, booleans and null as they are', () => {
    expect(redactJson({ n: 1, b: true, z: null }).value).toEqual({ n: 1, b: true, z: null });
  });

  it('does not mutate the value it was given', () => {
    const original = { token: GITHUB };
    redactJson(original);
    expect(original.token).toBe(GITHUB);
  });
});

describe('cost on adversarial input', () => {
  // The axis that blows up is how many start positions a pattern opens, not
  // how long one run is, so each case repeats a prefix that begins a match.
  // Sized at the limit the proxy accepts for a single message: a scan of ten
  // megabytes of `-eyJ` took forty eight seconds before the lookbehind fix and
  // passed the previous budget comfortably, because the input was a hundred
  // times smaller than anything real.
  const FRAMING_LIMIT = 10 * 1024 * 1024;

  it.each([
    ['jwt prefixes', '-eyJ'],
    ['github prefixes', '-ghp_'],
    ['aws prefixes', '-AKIA'],
    ['slack prefixes', '-xoxb'],
    ['bearer prefixes', 'Bearer '],
    ['private key prefixes', '-----BEGIN '],
    ['field names', 'api_key='],
    ['connection strings', 'a://b:c@'],
    ['one long run', 'A'],
  ])(
    'scans %s at the framing limit in under three seconds',
    (_name, unit) => {
      const text = unit.repeat(Math.ceil(FRAMING_LIMIT / unit.length));
      const started = performance.now();
      findSecrets(text);
      expect(performance.now() - started).toBeLessThan(3000);
    },
    60_000,
  );
});

describe('the word boundary is deliberate', () => {
  it('does not treat a key-shaped run inside a longer token as a credential', () => {
    // A hash or identifier that happens to contain the prefix is not a key, and
    // the model question is the backstop for anything this misses.
    expect(findSecrets(`abc${AWS}def`)).toEqual([]);
  });

  it('finds one that is delimited the way a real credential is', () => {
    for (const text of [`${AWS}`, `key=${AWS}`, `"${AWS}"`, `key: ${AWS},`, `(${AWS})`]) {
      expect(findSecrets(text).map((s) => s.kind)).toContain('aws_key');
    }
  });
});

describe('the credential rather than the identifier beside it', () => {
  it('redacts an AWS secret access key, not only the public key id', () => {
    const credentials = `aws_access_key_id = ${AWS}\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`;
    const redacted = redactText(credentials).text;
    expect(redacted).not.toContain('wJalrXUtnFEMI');
    expect(redacted).not.toContain(AWS);
  });

  it('redacts a bearer token, which carries no field name at all', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnop1234567890').text).not.toContain(
      'abcdefghijklmnop',
    );
  });

  it('redacts the password inside a connection string and keeps the host readable', () => {
    const redacted = redactText('postgres://admin:sup3rS3cretPw@db.internal:5432/prod').text;
    expect(redacted).not.toContain('sup3rS3cretPw');
    expect(redacted).toContain('db.internal');
  });

  it('redacts a password field', () => {
    expect(redactText('password: hunter2hunter2hunter2').text).not.toContain('hunter2hunter2');
  });
});

describe('overlapping matches', () => {
  it('merges a match that sits entirely inside another', () => {
    const text = `password=${'z'.repeat(40)}-${AWS} tail`;
    const redacted = redactText(text).text;
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted.match(/\[REDACTED:/g)).toHaveLength(1);
    expect(redacted).toContain(' tail');
  });

  it('leaves no tail in cleartext when a later secret reaches past an earlier one', () => {
    // The generic value stops at its own length bound partway through the key,
    // so the key's match begins inside the first one and ends after it.
    // Discarding it rather than extending left the last characters in the open.
    const padding = 'z'.repeat(4096 - 17);
    const text = `password=${padding}-${AWS} tail`;
    const redacted = redactText(text).text;
    // Asserted exactly. Checking for a recognisable fragment misses the case,
    // because what survived was the last four characters of the key.
    expect(redacted).toBe(`password=${placeholder('generic_api_key')} tail`);
  });
});

describe('redactJson on hostile shapes', () => {
  it('does not recurse forever on a value that refers to itself', () => {
    const cyclic: Record<string, unknown> = { token: GITHUB };
    cyclic['self'] = cyclic;
    const { value } = redactJson(cyclic);
    expect(JSON.stringify(value)).not.toContain(GITHUB);
  });

  it('stops before the stack does on a value deeper than any real argument', () => {
    let deep: unknown = AWS;
    for (let i = 0; i < 5000; i += 1) {
      deep = { deep };
    }
    expect(() => redactJson(deep)).not.toThrow();
  });

  it('keeps a __proto__ key as a property instead of setting the prototype', () => {
    const parsed: unknown = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const { value } = redactJson(parsed) as { value: Record<string, unknown> };
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('loses neither entry when two keys redact to the same placeholder', () => {
    const { value } = redactJson({ [`${AWS}`]: 1, [`${AWS.replace('7', '8')}`]: 2 });
    expect(Object.keys(value as object)).toHaveLength(2);
  });

  it('reports the kinds it replaced', () => {
    const { secrets } = redactJson({ a: AWS, b: { c: GITHUB } });
    expect([...secrets].sort()).toEqual(['aws_key', 'github_token']);
  });
});
