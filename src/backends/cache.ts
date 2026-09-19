/**
 * Answering the same question twice without asking twice.
 *
 * An agent rereads the same file, runs the same command and lists the same
 * directory many times in one session, and each of those is the same state and
 * the same battery, so it is the same request. Sending it again costs the user
 * money and the tool call latency, for an answer already known.
 *
 * Scoped to the process, which is to say to one session. Content changes
 * between sessions and a judgment about it should not outlive it, and a cache
 * held in memory has no staleness to manage, no file for two proxies to fight
 * over, and nothing new on disk that was derived from a user's content.
 *
 * The tool list is the exception and keeps its own record, because a tool
 * description is the rare thing that is genuinely the same next week.
 */

import { requestHash } from './hash.js';
import type { Backend, BackendResult, Battery } from './types.js';

/**
 * How many answers are held.
 *
 * Each is a small object, and the oldest go first. Well past a long session's
 * distinct questions, and bounded so that a session which never repeats itself
 * cannot grow this without limit.
 */
export const MAX_ENTRIES = 2_048;

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
}

export interface CachingOptions {
  readonly maxEntries?: number;
  /** Called when an answer came from here rather than from the backend. */
  readonly onHit?: () => void;
}

/**
 * Wrap a backend so identical requests are asked once.
 *
 * Only successful answers are kept. A failure is a statement about the moment
 * it happened, not about the question, so caching one would turn a rate limit
 * into a permanent verdict for the rest of the session.
 */
export function cachingBackend(
  inner: Backend,
  options: CachingOptions = {},
): Backend & {
  readonly stats: () => CacheStats;
} {
  const max = options.maxEntries ?? MAX_ENTRIES;
  // Insertion order is the eviction order, which a Map gives for free.
  const answers = new Map<string, BackendResult<Battery>>();
  let hits = 0;
  let misses = 0;

  return {
    name: inner.name,
    async ask<const B extends Battery>(
      state: unknown,
      battery: B,
      askOptions?: Parameters<Backend['ask']>[2],
    ): Promise<BackendResult<B>> {
      const key = requestHash(state, battery);
      const known = answers.get(key);
      if (known !== undefined) {
        hits += 1;
        options.onHit?.();
        // Re-inserted so that a question being asked repeatedly is the last to
        // be evicted rather than the first.
        answers.delete(key);
        answers.set(key, known);
        return known as BackendResult<B>;
      }

      misses += 1;
      const answer = await inner.ask(state, battery, askOptions);
      if (!answer.ok) {
        return answer;
      }
      // What is kept says it cost nothing, because asking it again costs
      // nothing. A cached answer that reported the original's tokens would have
      // the audit log adding up a bill for requests that were never sent.
      answers.set(key, { ...answer, inputTokens: 0, latencyMs: 0 } as BackendResult<Battery>);
      if (answers.size > max) {
        const oldest = answers.keys().next();
        if (!oldest.done) {
          answers.delete(oldest.value);
        }
      }
      return answer;
    },
    stats: () => ({ hits, misses, entries: answers.size }),
  };
}
