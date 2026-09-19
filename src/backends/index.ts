/**
 * Backends: one interface for asking a model a battery of typed questions.
 *
 * The TypeSafe implementation is the only one in v0.1.0. Others land later and
 * fit this interface without changing it.
 */

export { requestHash } from './hash.js';
export { MAX_MESSAGE_CHARS, failure, safeLabel, sanitizeMessage } from './message.js';
export {
  RecordingMismatchError,
  UnknownRequestError,
  answered,
  createFakeBackend,
  recordingFor,
} from './fake.js';
export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  TYPESAFE_API_KEY_ENV,
  createTypeSafeBackend,
  hasTypeSafeKey,
} from './typesafe.js';
export { validateAnswers, validateBattery } from './validate.js';

export type { AskRecord, Exchange, FakeBackend, FakeEntry, Recording } from './fake.js';
export type { TypeSafeBackendOptions } from './typesafe.js';
export type {
  Answer,
  AnswerFor,
  AnsweredResult,
  AnswersFor,
  AskOptions,
  Backend,
  BackendFailure,
  BackendResult,
  Battery,
  ChoiceQuestion,
  FailedResult,
  NoulQuestion,
  Question,
  ScoreQuestion,
} from './types.js';
export type { Validation } from './validate.js';
export { MAX_ENTRIES as MAX_CACHED_JUDGMENTS, cachingBackend } from './cache.js';
export type { CacheStats, CachingOptions } from './cache.js';
