/**
 * The tool-list screen: one advertised tool turned into one request.
 *
 * Unlike a result, a tool list is not one piece of text that happens to be
 * long. It is many short, independent claims, and they change at different
 * times. So each tool is its own request rather than a chunk of a shared one:
 * an answer is then about one description, can be cached against that
 * description's digest, and a list of fifty tools where one changed costs one
 * request rather than fifty.
 */

import type { Answer, Battery } from '../backends/index.js';
import { noulOf } from './precall.js';
import { TOOLLIST_UNMEASURED } from './questions.js';

/**
 * The longest description this will send.
 *
 * Not a truncation point. A description longer than this is reported as unread
 * rather than screened from its opening: judging a prefix and keeping the answer
 * against the whole text is exactly the bypass a long description buys, since
 * the part that matters can simply be put after the cut.
 *
 * Well past any description written to be read by a person.
 */
export const MAX_DESCRIPTION_CHARS = 8_000;

/** The text a description amounts to, or undefined when it is too long to judge. */
export function describableText(description: unknown): string | undefined {
  const text = typeof description === 'string' ? description : (JSON.stringify(description) ?? '');
  return text.length > MAX_DESCRIPTION_CHARS ? undefined : text;
}

export interface ToolListState {
  readonly tool: {
    readonly name: string;
    readonly description: string;
  };
}

export interface ToolListScreen {
  readonly state: string;
  readonly battery: Battery;
}

export interface ToolListAnswers {
  readonly description_steers?: number;
}

export function buildToolListScreen(name: string, description: string): ToolListScreen {
  const state: ToolListState = { tool: { name, description } };
  return { state: JSON.stringify(state), battery: TOOLLIST_UNMEASURED };
}

export function readToolListAnswers(answers: Readonly<Record<string, Answer>>): ToolListAnswers {
  const steers = noulOf(answers, 'description_steers');
  return steers === undefined ? {} : { description_steers: steers };
}
