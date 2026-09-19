#!/usr/bin/env node
/**
 * Print one version's section of CHANGELOG.md.
 *
 * The release page and the changelog describe the same release, so only one of
 * them should be written. This lets the workflow use the changelog, which is the
 * one that says what changed rather than which pull requests were merged.
 *
 * Exits non-zero when the section is not there, so a caller can fall back rather
 * than publishing an empty release body.
 *
 * Usage: node scripts/changelog-section.mjs [version] [path]
 */

import { readFileSync } from 'node:fs';

/**
 * The lines under `## <version>`, up to the next heading at the same level.
 *
 * Matched on the whole line so that `0.2.0` does not match `0.2.0-rc.1`, and so
 * a version named inside a sentence elsewhere in the file is not mistaken for
 * the start of a section.
 */
export function sectionFor(changelog, version) {
  const lines = changelog.split('\n');
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body.length > 0 ? body : undefined;
}

const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  const version = process.argv[2] ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
  const path = process.argv[3] ?? 'CHANGELOG.md';
  let section;
  try {
    section = sectionFor(readFileSync(path, 'utf8'), version);
  } catch {
    section = undefined;
  }
  if (section === undefined) {
    process.stderr.write(`No section for ${version} in ${path}\n`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
