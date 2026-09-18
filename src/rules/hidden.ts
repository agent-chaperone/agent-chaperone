/**
 * Text that a person reading the result would not see.
 *
 * Code finds these; the model judges what they say. Reporting them separately
 * matters because a hidden instruction is the shape an injection usually takes,
 * and a reviewer looking at the audit log should be able to see that something
 * was concealed even when the judgment came back low.
 */

export type HiddenKind =
  | 'zero_width'
  | 'bidi_control'
  | 'html_comment'
  | 'hidden_style'
  | 'base64_run'
  | 'private_use'
  | 'tag_characters';

export interface HiddenRegion {
  readonly block: number;
  readonly kind: HiddenKind;
  /** Where it starts within that block, so a reviewer can find it. */
  readonly offset: number;
  readonly length: number;
}

interface Detector {
  readonly kind: HiddenKind;
  readonly pattern: RegExp;
}

/** A base64 run has to be long before it is suspicious, or every hash trips it. */
const BASE64_RUN_MINIMUM = 160;

/**
 * Every run is bounded above as well as below.
 *
 * An unbounded quantifier over ten megabytes of one repeated character
 * exhausts the regular expression engine's own stack and throws, and how much
 * it takes depends on the machine: a run of invisible characters passed here
 * and crashed on a smaller CI runner. A long payload is reported as several
 * adjacent runs instead of one impossible match, which is the same finding.
 */
const RUN_MAXIMUM = 4096;

/** A hostile result cannot make this report more than a bounded number of findings. */
export const MAX_HIDDEN_REGIONS = 5000;

/** Past this a comment is not a comment, and scanning further is not worth the time. */
const MAX_COMMENT_CHARS = 8192;

const DETECTORS: readonly Detector[] = [
  // Written as escapes on purpose: the literal characters are invisible in an
  // editor, which is the whole reason they are worth detecting. The left and
  // right marks U+200E and U+200F are excluded: they appear in ordinary
  // right-to-left text and flagging them would report every Arabic or Hebrew
  // document as concealing something.
  {
    kind: 'zero_width',
    pattern: new RegExp(`[\\u200B-\\u200D\\u2060-\\u2064]{1,${RUN_MAXIMUM}}`, 'gu'),
  },
  {
    kind: 'bidi_control',
    pattern: new RegExp(`[\\u202A-\\u202E\\u2066-\\u2069]{1,${RUN_MAXIMUM}}`, 'gu'),
  },
  {
    kind: 'hidden_style',
    // The size and opacity forms end on a digit boundary rather than \b, which
    // succeeds on a decimal point and so matched every fractional value.
    pattern:
      /(?:display\s{0,4}:\s{0,4}none|visibility\s{0,4}:\s{0,4}hidden|font-size\s{0,4}:\s{0,4}0(?:px|em|pt|rem)?(?![.0-9])|opacity\s{0,4}:\s{0,4}0(?:\.0+)?(?![.0-9]))/giu,
  },
  {
    kind: 'base64_run',
    pattern: new RegExp(`[A-Za-z0-9+/]{${BASE64_RUN_MINIMUM},${RUN_MAXIMUM}}={0,2}`, 'gu'),
  },
  { kind: 'private_use', pattern: new RegExp(`[\\uE000-\\uF8FF]{1,${RUN_MAXIMUM}}`, 'gu') },
  // Tag characters render as nothing anywhere and exist only to carry data.
  // They live outside the basic plane, which is why the `u` flag matters.
  { kind: 'tag_characters', pattern: /[\u{E0000}-\u{E007F}]+/gu },
];

/**
 * HTML comments, found by scanning rather than by a regular expression.
 *
 * A lazy quantifier bounded at several thousand characters begins a match at
 * every `<!--` and reads to that bound before failing, which on a document full
 * of them is quadratic. Two index lookups per comment is linear.
 */
function findComments(text: string, block: number): readonly HiddenRegion[] {
  // Both ends are collected in one forward pass each, then paired with a cursor
  // that only advances. Searching for a closer from every opener re-reads the
  // rest of the document each time, which on a run of `<!--` with no closer at
  // all is quadratic: ten megabytes of it never finished.
  const closers: number[] = [];
  for (let at = text.indexOf('-->'); at !== -1; at = text.indexOf('-->', at + 3)) {
    closers.push(at);
  }
  if (closers.length === 0) {
    return [];
  }

  const regions: HiddenRegion[] = [];
  let next = 0;
  for (let at = text.indexOf('<!--'); at !== -1; at = text.indexOf('<!--', at + 4)) {
    while (next < closers.length && (closers[next] ?? 0) < at + 4) {
      next += 1;
    }
    const close = closers[next];
    if (close === undefined) {
      break;
    }
    // Too far apart to be a comment anyone wrote, so treat it as unterminated.
    if (close - at <= MAX_COMMENT_CHARS) {
      regions.push({ block, kind: 'html_comment', offset: at, length: close + 3 - at });
    }
  }
  return regions;
}

/** Everything concealed in one block of text. */
export function findHiddenInText(text: string, block = 0): readonly HiddenRegion[] {
  const regions: HiddenRegion[] = [...findComments(text, block)];
  for (const { kind, pattern } of DETECTORS) {
    const scanner = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(scanner)) {
      regions.push({ block, kind, offset: match.index, length: match[0].length });
      if (regions.length >= MAX_HIDDEN_REGIONS) {
        break;
      }
    }
  }
  return regions.sort((a, b) => a.offset - b.offset);
}

/** The same across a result that has already been split into blocks. */
export function findHiddenRegions(
  blocks: readonly { readonly id: number; readonly text: string }[],
): readonly HiddenRegion[] {
  return blocks.flatMap((block) => findHiddenInText(block.text, block.id));
}
