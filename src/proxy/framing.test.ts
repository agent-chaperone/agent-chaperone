import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_LINE_BYTES, LineBuffer, LineTooLongError, frame } from './framing.js';

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('LineBuffer', () => {
  it('yields complete lines and holds the remainder', () => {
    const buffer = new LineBuffer();
    buffer.append(utf8('{"a":1}\n{"b":2}\n{"c"'));
    expect(buffer.drain()).toEqual(['{"a":1}', '{"b":2}']);
    expect(buffer.pendingBytes).toBe(4);
  });

  it('reassembles a line split across chunks', () => {
    const buffer = new LineBuffer();
    buffer.append(utf8('{"a":'));
    expect(buffer.drain()).toEqual([]);
    buffer.append(utf8('1}\n'));
    expect(buffer.drain()).toEqual(['{"a":1}']);
  });

  it('strips a carriage return but nothing else', () => {
    const buffer = new LineBuffer();
    buffer.append(utf8('{"a": 1}  \r\n'));
    expect(buffer.drain()).toEqual(['{"a": 1}  ']);
  });

  it('skips blank lines rather than passing empty messages on', () => {
    const buffer = new LineBuffer();
    buffer.append(utf8('\n\n{"a":1}\n'));
    expect(buffer.drain()).toEqual(['{"a":1}']);
  });

  it('handles multi-byte characters that straddle a chunk boundary', () => {
    const buffer = new LineBuffer();
    const line = utf8('{"text":"日本語"}\n');
    buffer.append(line.subarray(0, 12));
    buffer.append(line.subarray(12));
    expect(buffer.drain()).toEqual(['{"text":"日本語"}']);
  });

  it('refuses a line that passes the size limit instead of buffering forever', () => {
    const buffer = new LineBuffer(64);
    buffer.append(utf8('x'.repeat(200)));
    expect(() => buffer.drain()).toThrow(LineTooLongError);
  });

  it('recovers its memory when it refuses a line', () => {
    const buffer = new LineBuffer(64);
    buffer.append(utf8('x'.repeat(200)));
    expect(() => buffer.drain()).toThrow();
    expect(buffer.pendingBytes).toBe(0);
  });

  it('buffers a large newline-free input up to the limit without error', () => {
    const buffer = new LineBuffer(DEFAULT_MAX_LINE_BYTES);
    const started = performance.now();
    for (let i = 0; i < 64; i += 1) {
      buffer.append(utf8('x'.repeat(16 * 1024)));
      buffer.drain();
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('frames a line with exactly one newline', () => {
    expect(frame('{"a":1}')).toBe('{"a":1}\n');
  });
});
