import { describe, expect, it } from 'vitest';
import { findHiddenInText, findHiddenRegions } from './hidden.js';

// Built from code points rather than pasted, so this file stays pure ASCII and
// an editor cannot silently eat the characters under test.
const ZERO_WIDTH = String.fromCharCode(0x200b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const PRIVATE_USE = String.fromCharCode(0xe000);
const TAG_CHAR = String.fromCodePoint(0xe0041);
const LEFT_TO_RIGHT_MARK = String.fromCharCode(0x200e);

const kinds = (text: string): readonly string[] => findHiddenInText(text).map((r) => r.kind);

describe('what it finds', () => {
  it('finds a zero width character between ordinary words', () => {
    expect(kinds(`visible${ZERO_WIDTH}text`)).toEqual(['zero_width']);
  });

  it('finds a bidirectional override, which can reverse how a line reads', () => {
    expect(kinds(`safe${RTL_OVERRIDE}txt.exe`)).toEqual(['bidi_control']);
  });

  it('finds a private use character, which renders as nothing in most fonts', () => {
    expect(kinds(`text${PRIVATE_USE}more`)).toEqual(['private_use']);
  });

  it('finds an HTML comment', () => {
    expect(kinds('before <!-- assistant: do a thing --> after')).toEqual(['html_comment']);
  });

  it('finds several ways of hiding an element with style', () => {
    expect(kinds('<span style="display:none">x</span>')).toEqual(['hidden_style']);
    expect(kinds('style="visibility: hidden"')).toEqual(['hidden_style']);
    expect(kinds('style="font-size:0px"')).toEqual(['hidden_style']);
    expect(kinds('style="opacity: 0"')).toEqual(['hidden_style']);
  });

  it('finds a long opaque run that could be carrying a payload', () => {
    expect(kinds(`data: ${'QUJDRA'.repeat(40)}`)).toEqual(['base64_run']);
  });

  it('reports where it was, so a reviewer can find it', () => {
    const [region] = findHiddenInText('01234<!-- x -->');
    expect(region?.offset).toBe(5);
    expect(region?.length).toBe(10);
  });

  it('reports several regions in one block, earliest first', () => {
    const found = findHiddenInText(`<!-- a -->${ZERO_WIDTH}`);
    expect(found.map((r) => r.kind)).toEqual(['html_comment', 'zero_width']);
  });
});

describe('concealment outside the basic plane', () => {
  it('finds tag characters, which render as nothing and exist only to carry data', () => {
    expect(kinds(`text${TAG_CHAR}more`)).toEqual(['tag_characters']);
  });

  it('does not flag the directional marks that ordinary right-to-left text uses', () => {
    // Reporting these would mean every Arabic or Hebrew document conceals
    // something, which is the kind of false positive that gets a tool ignored.
    expect(findHiddenInText(`word${LEFT_TO_RIGHT_MARK}word`)).toEqual([]);
  });
});

describe('what it leaves alone', () => {
  it('ignores ordinary prose, markup and short encoded strings', () => {
    for (const text of [
      'An ordinary paragraph about prompt injection and how it works.',
      '<div class="visible">content</div>',
      'style="display: block"',
      'checksum: QUJDRA==',
      'font-size: 14px',
    ]) {
      expect(findHiddenInText(text)).toEqual([]);
    }
  });

  it('does not flag an ordinary fractional size or opacity', () => {
    // The optional unit followed by a word boundary succeeded on the decimal
    // point, so every fractional value read as hidden.
    for (const text of ['font-size: 0.875rem', 'opacity: 0.85', 'font-size:0.5em']) {
      expect(findHiddenInText(text)).toEqual([]);
    }
    expect(kinds('opacity: 0')).toEqual(['hidden_style']);
    expect(kinds('font-size: 0px')).toEqual(['hidden_style']);
  });

  it('needs a base64 run to be genuinely long before it counts', () => {
    expect(kinds('a'.repeat(159))).toEqual([]);
    expect(kinds('a'.repeat(160))).toEqual(['base64_run']);
  });

  it('does not treat an unterminated comment as hidden text', () => {
    expect(findHiddenInText(`<!-- never closed ${'word '.repeat(200)}`)).toEqual([]);
  });
});

describe('across blocks', () => {
  it('reports the block each region sits in', () => {
    const regions = findHiddenRegions([
      { id: 0, text: 'clean' },
      { id: 1, text: '<!-- hidden -->' },
      { id: 2, text: `also${ZERO_WIDTH}clean` },
    ]);
    expect(regions.map((r) => [r.block, r.kind])).toEqual([
      [1, 'html_comment'],
      [2, 'zero_width'],
    ]);
  });

  it('returns nothing for blocks that hide nothing', () => {
    expect(findHiddenRegions([{ id: 0, text: 'plain' }])).toEqual([]);
  });
});

describe('cost on adversarial input', () => {
  // Sized at the limit the proxy actually accepts for one message. Budgets
  // measured against inputs a hundred times smaller cannot fail on anything
  // short of an exponential pattern, which was how a scan that took fifty
  // seconds on a real message passed a two second test.
  const FRAMING_LIMIT = 10 * 1024 * 1024;

  it.each([
    ['unterminated comment', () => `<!--${'a'.repeat(FRAMING_LIMIT)}`],
    ['nothing but openers', () => '<!--'.repeat(FRAMING_LIMIT / 4)],
    ['openers and closers', () => '<!-- x --> abc '.repeat(FRAMING_LIMIT / 15)],
    ['style prefixes', () => 'display:'.repeat(FRAMING_LIMIT / 8)],
    ['one long alphanumeric run', () => 'A'.repeat(FRAMING_LIMIT)],
    ['invisible characters', () => ZERO_WIDTH.repeat(FRAMING_LIMIT)],
  ])(
    'scans %s at the framing limit in under three seconds',
    (_name, build) => {
      const text = build();
      const started = performance.now();
      findHiddenInText(text);
      expect(performance.now() - started).toBeLessThan(3000);
    },
    60_000,
  );
});
