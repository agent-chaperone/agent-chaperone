/**
 * Putting a paginated tool list back together before anything judges it.
 *
 * `tools/list` answers with a page and a `nextCursor`, and the client asks again
 * until a page comes back without one. Treating each page as a whole list
 * compares a server against a slice of itself, which reports the other pages as
 * removed on every connection: a warning that can never be cleared, which is a
 * warning people learn to scroll past.
 *
 * So pages are collected and nothing is compared until the listing ends. A
 * request carrying no cursor starts a fresh one, which is also how a second
 * listing in the same session replaces the first rather than appending to it.
 */

import type { AdvertisedTool } from './baseline.js';
import { advertisedTools } from './baseline.js';

/**
 * How many pages one listing may take, and how many tools it may carry.
 *
 * Both are the server's choice, and a cursor that never resolves is a server
 * keeping state in this process for as long as the session lasts. Past either
 * bound the listing is abandoned rather than held: it is reported as unread,
 * which is the honest outcome, instead of silently becoming a baseline built
 * from part of a list.
 */
export const MAX_PAGES = 64;
export const MAX_TOOLS = 4_096;

export type Assembly =
  /** More pages are expected. Nothing to compare yet. */
  | { readonly kind: 'incomplete'; readonly pages: number }
  | { readonly kind: 'complete'; readonly tools: readonly AdvertisedTool[]; readonly pages: number }
  | { readonly kind: 'abandoned'; readonly reason: 'pages' | 'tools' };

function cursorOf(request: unknown): unknown {
  if (request === null || typeof request !== 'object') {
    return undefined;
  }
  const params = (request as { params?: unknown }).params;
  if (params === null || typeof params !== 'object') {
    return undefined;
  }
  return (params as { cursor?: unknown }).cursor;
}

function nextCursorOf(result: unknown): unknown {
  if (result === null || typeof result !== 'object') {
    return undefined;
  }
  return (result as { nextCursor?: unknown }).nextCursor;
}

/**
 * One server's listing in progress.
 *
 * Held per proxy, which is per server, so there is no key to get wrong. A
 * client that interleaves two listings against one server would confuse it, but
 * that is not a thing a client does: the cursor is what it was just handed.
 */
export class ToolListAssembly {
  #pages: AdvertisedTool[][] = [];
  #count = 0;
  #abandoned = false;

  /**
   * Take one `tools/list` response.
   *
   * `request` is the parsed request it answers, read only for its cursor, which
   * is what says whether this continues a listing or starts one.
   */
  add(request: unknown, result: unknown): Assembly {
    // No cursor means a fresh listing. Anything held from a previous one is
    // dropped rather than appended to, so a second listing replaces the first.
    if (cursorOf(request) === undefined) {
      this.#pages = [];
      this.#count = 0;
      this.#abandoned = false;
    } else if (this.#abandoned) {
      // Once a listing is past its bounds, the rest of its pages are ignored
      // rather than reported again for each one.
      return { kind: 'abandoned', reason: 'pages' };
    }

    const page = advertisedTools(result);
    this.#pages.push(page);
    this.#count += page.length;

    if (this.#pages.length > MAX_PAGES) {
      this.#abandoned = true;
      this.#pages = [];
      return { kind: 'abandoned', reason: 'pages' };
    }
    if (this.#count > MAX_TOOLS) {
      this.#abandoned = true;
      this.#pages = [];
      return { kind: 'abandoned', reason: 'tools' };
    }

    if (nextCursorOf(result) !== undefined) {
      return { kind: 'incomplete', pages: this.#pages.length };
    }

    const tools = this.#pages.flat();
    const pages = this.#pages.length;
    this.#pages = [];
    this.#count = 0;
    return { kind: 'complete', tools, pages };
  }
}
