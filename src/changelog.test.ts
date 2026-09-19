import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sectionFor } from '../scripts/changelog-section.mjs';

const CHANGELOG = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));

const sample = `# agent-chaperone

## 0.2.0

### Minor Changes

- abc1234: Did a thing.

## 0.1.0

### Minor Changes

- First published release.
`;

describe('taking one release out of the changelog', () => {
  it('returns only that version, not the ones under it', () => {
    const section = sectionFor(sample, '0.2.0');

    expect(section).toContain('Did a thing.');
    expect(section).not.toContain('First published release.');
  });

  it('reads the last section, which has no heading after it', () => {
    expect(sectionFor(sample, '0.1.0')).toContain('First published release.');
  });

  it('is undefined for a version that is not in the file', () => {
    expect(sectionFor(sample, '9.9.9')).toBeUndefined();
  });

  it('does not match a longer version that starts with the one asked for', () => {
    // `0.2.0` must not find `0.2.0-rc.1`, or a release candidate's notes would
    // be published as the release's.
    const withPrerelease = sample.replace('## 0.2.0', '## 0.2.0-rc.1');

    expect(sectionFor(withPrerelease, '0.2.0')).toBeUndefined();
  });

  it('is undefined for a heading with nothing under it, so the caller can fall back', () => {
    expect(sectionFor('# c\n\n## 0.3.0\n\n## 0.2.0\n\n- something\n', '0.3.0')).toBeUndefined();
  });

  it('is undefined rather than throwing on an empty file', () => {
    expect(sectionFor('', '0.2.0')).toBeUndefined();
  });

  it('finds the version this package is actually on, in the real changelog', () => {
    const version = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ).version as string;

    // The workflow falls back when this is missing, but the fallback exists for
    // a malformed file, not for the ordinary case. If this fails, every release
    // from here on quietly publishes pull request titles instead.
    expect(sectionFor(readFileSync(CHANGELOG, 'utf8'), version)).toBeTypeOf('string');
  });
});
