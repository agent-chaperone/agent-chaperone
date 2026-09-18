import { describe, expect, it } from 'vitest';
import * as backends from './index.js';

/**
 * The barrel is the whole of what the rest of the package imports, and a name
 * dropped from it is invisible to the compiler: nothing else in the tree
 * imports these yet. This is the one thing that notices.
 */
const EXPORTED = [
  'DEFAULT_MAX_RETRIES',
  'DEFAULT_TIMEOUT_MS',
  'DEFAULT_TOTAL_TIMEOUT_MS',
  'MAX_MESSAGE_CHARS',
  'RecordingMismatchError',
  'TYPESAFE_API_KEY_ENV',
  'UnknownRequestError',
  'answered',
  'createFakeBackend',
  'createTypeSafeBackend',
  'failure',
  'hasTypeSafeKey',
  'recordingFor',
  'requestHash',
  'safeLabel',
  'sanitizeMessage',
  'validateAnswers',
  'validateBattery',
];

describe('the backends barrel', () => {
  it.each(EXPORTED)('exports %s', (name) => {
    expect(Object.hasOwn(backends, name)).toBe(true);
  });
});
