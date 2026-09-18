/** Writable stand-ins for exercising the relay's failure and backpressure paths. */
import { Writable } from 'node:stream';

/** Accepts writes but never completes them until `release()` is called. */
export class BlockingSink extends Writable {
  readonly chunks: string[] = [];
  #waiting: (() => void)[] = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(chunk: Buffer, _encoding: string, done: (error?: Error) => void): void {
    this.chunks.push(chunk.toString('utf8'));
    this.#waiting.push(() => done());
  }

  release(): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const done of waiting) {
      done();
    }
  }
}

/** Fails every write with the given errno, the way a closed pipe does. */
export class FailingSink extends Writable {
  constructor(private readonly code: string) {
    super();
  }

  override _write(_chunk: Buffer, _encoding: string, done: (error?: Error) => void): void {
    done(Object.assign(new Error(`write ${this.code}`), { code: this.code }));
  }
}

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
