import { describe, expect, it } from 'vitest';
import { firstMatch, matchesGlob } from './globs.js';

describe('matchesGlob', () => {
  it('matches an exact name', () => {
    expect(matchesGlob('read_file', 'read_file')).toBe(true);
    expect(matchesGlob('read_file', 'write_file')).toBe(false);
  });

  it('matches a prefix, a suffix and a middle', () => {
    expect(matchesGlob('get_*', 'get_issue')).toBe(true);
    expect(matchesGlob('get_*', 'set_issue')).toBe(false);
    expect(matchesGlob('*_file', 'read_file')).toBe(true);
    expect(matchesGlob('read_*_v2', 'read_the_file_v2')).toBe(true);
  });

  it('lets a star match nothing at all', () => {
    expect(matchesGlob('get_*', 'get_')).toBe(true);
    expect(matchesGlob('*', '')).toBe(true);
    expect(matchesGlob('**', 'anything')).toBe(true);
  });

  it('matches exactly one character with a question mark', () => {
    expect(matchesGlob('file?', 'file1')).toBe(true);
    expect(matchesGlob('file?', 'file')).toBe(false);
    expect(matchesGlob('file?', 'file12')).toBe(false);
  });

  it('treats regular expression metacharacters as ordinary text', () => {
    expect(matchesGlob('a.b', 'a.b')).toBe(true);
    expect(matchesGlob('a.b', 'axb')).toBe(false);
    expect(matchesGlob('a+b', 'a+b')).toBe(true);
    expect(matchesGlob('(x)', '(x)')).toBe(true);
  });

  it('is case sensitive, because tool names are', () => {
    expect(matchesGlob('Get_*', 'get_issue')).toBe(false);
  });

  it('stays fast on the pattern that makes a naive matcher backtrack', () => {
    const started = performance.now();
    for (const pattern of ['*a*a*a*a*a*a*b', 'a*a*a*a*a*a*a*c', '*?*?*?*?*?*?*?*z']) {
      expect(matchesGlob(pattern, 'a'.repeat(4000))).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('firstMatch', () => {
  it('returns the first pattern that matches, so the reason names the specific rule', () => {
    expect(firstMatch(['delete_*', '*_file'], 'delete_file')).toBe('delete_*');
  });

  it('returns nothing when the list is empty or nothing matches', () => {
    expect(firstMatch([], 'read_file')).toBeUndefined();
    expect(firstMatch(['write_*'], 'read_file')).toBeUndefined();
  });
});

describe('a wildcard character inside the value', () => {
  it('treats it as ordinary text, so a deny-everything pattern still denies it', () => {
    // A server picks its own tool names. One called `*danger` used to slip a
    // deny list of `*` entirely, because the literal comparison ran first.
    expect(matchesGlob('*', '*danger')).toBe(true);
    expect(matchesGlob('admin_*', 'admin_*danger')).toBe(true);
    expect(matchesGlob('a*', 'a*b')).toBe(true);
    expect(firstMatch(['*'], '*danger')).toBe('*');
  });

  it('still refuses a value a pattern does not cover', () => {
    expect(matchesGlob('get_*', '*get_thing')).toBe(false);
  });
});
