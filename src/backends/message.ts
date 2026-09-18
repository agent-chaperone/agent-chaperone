/**
 * Building the one line a failure carries, and the one label a judgment stores.
 *
 * Both reach the audit log, and the audit log is something the agent can be
 * shown. So neither is allowed to carry text a server chose: the callers build
 * their messages from the status and the error class, a stored identifier has to
 * look like an identifier or it is dropped, and whatever gets through here is
 * bounded, single line, and stripped of anything that could rewrite a terminal
 * or reverse the reading order of the text around it.
 */

import { redactText } from '../rules/secrets.js';
import type { BackendFailure, FailedResult } from './types.js';

export const MAX_MESSAGE_CHARS = 200;

/**
 * Control characters, bidi overrides and zero-width marks. Tab, newline and
 * carriage return are left out, because the whitespace collapse below turns
 * those into spaces, which reads better than dropping them.
 */
const CONCEALED =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Identifiers a server picks, such as a model version, in the only shape one takes. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;

function cut(text: string, limit: number): string {
  const sliced = text.slice(0, limit);
  const last = sliced.charCodeAt(limit - 1);
  // A high surrogate at the end lost the half that gave it meaning.
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/** One line, bounded, with secret shapes replaced and concealment removed. */
export function sanitizeMessage(raw: string): string {
  const collapsed = redactText(raw).text.replace(CONCEALED, '').replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_MESSAGE_CHARS
    ? `${cut(collapsed, MAX_MESSAGE_CHARS - 1)}\u2026`
    : collapsed;
}

/**
 * An identifier a server sent, kept only when it looks like one. A model version
 * is recorded with the judgment it produced, which makes it the same channel as
 * a failure message and not a place for a sentence.
 */
export function safeLabel(raw: unknown): string {
  return typeof raw === 'string' && LABEL.test(raw) ? raw : 'unknown';
}

/** The only way a backend in this package reports a failure, so the scrub cannot be skipped. */
export function failure(
  kind: BackendFailure['kind'],
  retryable: boolean,
  message: string,
): FailedResult {
  return { ok: false, failure: { kind, retryable, message: sanitizeMessage(message) } };
}
