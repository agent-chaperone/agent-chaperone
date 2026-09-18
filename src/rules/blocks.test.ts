import { describe, expect, it } from 'vitest';
import { splitIntoBlocks } from './blocks.js';

describe('splitIntoBlocks', () => {
  it('splits on blank lines and numbers the blocks from zero', () => {
    const { blocks } = splitIntoBlocks('first\n\nsecond\n\nthird');
    expect(blocks).toEqual([
      { id: 0, text: 'first' },
      { id: 1, text: 'second' },
      { id: 2, text: 'third' },
    ]);
  });

  it('keeps line breaks inside a paragraph', () => {
    const { blocks } = splitIntoBlocks('line one\nline two\n\nnext');
    expect(blocks[0]?.text).toBe('line one\nline two');
  });

  it('ignores runs of blank lines and surrounding whitespace', () => {
    const { blocks } = splitIntoBlocks('\n\n  first  \n\n   \n\nsecond\n\n');
    expect(blocks.map((b) => b.text)).toEqual(['first', 'second']);
  });

  it('treats a blank line with trailing spaces as a boundary', () => {
    expect(splitIntoBlocks('a\n   \nb').blocks).toHaveLength(2);
  });

  it('splits a paragraph too long to be one block', () => {
    const { blocks } = splitIntoBlocks('x'.repeat(250), { maxBlockChars: 100 });
    expect(blocks.map((b) => b.text.length)).toEqual([100, 100, 50]);
    expect(blocks.map((b) => b.id)).toEqual([0, 1, 2]);
  });

  it('stops at the block limit and says how many it dropped', () => {
    const text = Array.from({ length: 10 }, (_, i) => `p${i}`).join('\n\n');
    const { blocks, dropped } = splitIntoBlocks(text, { maxBlocks: 4 });
    expect(blocks).toHaveLength(4);
    expect(dropped).toBe(6);
  });

  it('drops nothing when everything fits', () => {
    expect(splitIntoBlocks('a\n\nb').dropped).toBe(0);
  });

  it('returns nothing for text that is only whitespace', () => {
    expect(splitIntoBlocks('   \n\n  \n').blocks).toEqual([]);
  });

  it('never produces a zero-length block, whatever the cap', () => {
    const { blocks } = splitIntoBlocks('abc', { maxBlockChars: 0 });
    expect(blocks.every((b) => b.text.length > 0)).toBe(true);
  });

  it('stays fast on a large result', () => {
    const text = `${'word '.repeat(20)}\n\n`.repeat(5000);
    const started = performance.now();
    splitIntoBlocks(text, { maxBlocks: 100_000 });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('line endings and what gets dropped', () => {
  it('splits a CRLF document at its blank lines', () => {
    // Matching only LF turned a Windows or HTTP-sourced result into one
    // paragraph chopped at arbitrary offsets.
    const { blocks } = splitIntoBlocks('first\r\n\r\nsecond\r\n\r\nthird');
    expect(blocks.map((b) => b.text)).toEqual(['first', 'second', 'third']);
  });

  it('says how much text it dropped, not just how many blocks', () => {
    const text = Array.from({ length: 6 }, () => 'x'.repeat(50)).join('\n\n');
    const { dropped, dropped_chars } = splitIntoBlocks(text, { maxBlocks: 2 });
    expect(dropped).toBe(4);
    expect(dropped_chars).toBe(200);
  });

  it('does not cut a surrogate pair in half', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const { blocks } = splitIntoBlocks(emoji.repeat(10), { maxBlockChars: 5 });
    for (const block of blocks) {
      expect([...block.text].every((c) => c === emoji)).toBe(true);
    }
    expect(blocks.map((b) => b.text).join('')).toBe(emoji.repeat(10));
  });
});
