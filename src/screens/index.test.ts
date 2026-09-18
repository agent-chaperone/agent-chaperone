import { describe, expect, it } from 'vitest';
import * as screens from './index.js';

/**
 * The barrel is what the proxy imports in #8, and a name dropped from it is
 * invisible to the compiler while nothing else imports it yet.
 */
const EXPORTED = [
  'CALL_SEVERITY',
  'DEFAULT_MAX_STATE_CHARS',
  'DESTRUCTIVE',
  'EXFILTRATION',
  'EXPOSES_SECRET',
  'INSTRUCTS_READER',
  'NO_BLOCK',
  'OFF_TASK',
  'POLICY_VIOLATION',
  'POSTRESULT_MEASURED',
  'PRECALL_MEASURED',
  'RESULT_SEVERITY',
  'SECRET_IN_ARGS',
  'buildPostResultScreens',
  'buildPreCallScreen',
  'chunkBlocks',
  'mergeResultAnswers',
  'noulOf',
  'readCallAnswers',
  'readResultAnswers',
  'scoreOf',
  'whichBlock',
];

describe('the screens barrel', () => {
  it.each(EXPORTED)('exports %s', (name) => {
    expect(Object.hasOwn(screens, name)).toBe(true);
  });
});
