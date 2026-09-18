/** Test helpers for driving the proxy over in-memory streams. */
import type { Readable } from 'node:stream';

/** Resolve once `count` complete lines have arrived, or reject on a timeout. */
export function readLines(stream: Readable, count: number, timeoutMs = 2000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let pending = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`expected ${count} lines, saw ${lines.length}`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString('utf8');
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line.length > 0) {
          lines.push(line);
        }
        if (lines.length >= count) {
          cleanup();
          resolve(lines);
          return;
        }
        index = pending.indexOf('\n');
      }
    };

    stream.on('data', onData);
    stream.on('error', onError);
  });
}
