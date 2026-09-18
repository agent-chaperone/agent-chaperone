/**
 * Checking a battery before it is sent and answers before they are believed.
 *
 * The decision rules read these numbers straight into thresholds. A missing id,
 * a string where a probability belongs, or a score past the end of its rubric
 * would turn into a comparison against `undefined` and a quiet forward, so the
 * answers are checked here once and every path after this can trust them.
 *
 * Both functions are public and total: they are given `unknown` in all but name,
 * because a battery can be built from a policy file and answers arrive from a
 * server, and neither is allowed to make the caller handle an exception.
 *
 * Nothing a server chose is repeated back in a problem string. These strings
 * become failure messages, and a failure message reaches the audit log.
 */

import type { Answer, AnswersFor, Battery, Question } from './types.js';

export type Validation<B extends Battery> =
  | { readonly ok: true; readonly answers: AnswersFor<B> }
  | { readonly ok: false; readonly problem: string };

const KINDS = new Set(['noul', 'choice', 'score']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A probability. The comparisons already exclude NaN and both infinities, which
 * is why there is no separate finiteness check.
 */
function isProbability(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function checkQuestion(id: string, raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return `question "${id}" is not an object`;
  }
  if (typeof raw['kind'] !== 'string' || !KINDS.has(raw['kind'])) {
    return `question "${id}" is not a kind of question this package asks`;
  }
  if (typeof raw['instructions'] !== 'string' || raw['instructions'].trim() === '') {
    return `question "${id}" has no instructions`;
  }
  if (raw['kind'] === 'score') {
    const criteria = raw['criteria'];
    if (!Array.isArray(criteria) || criteria.length < 2) {
      return `score question "${id}" needs at least two levels`;
    }
  }
  if (raw['kind'] === 'choice') {
    const criteria = raw['criteria'];
    if (!isRecord(criteria) || Object.keys(criteria).length < 2) {
      return `choice question "${id}" needs at least two outcomes`;
    }
  }
  return undefined;
}

/** Describes what is wrong with the battery, or undefined when it is askable. */
export function validateBattery(battery: Battery): string | undefined {
  const raw: unknown = battery;
  if (!isRecord(raw)) {
    return 'the battery is not an object';
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    return 'the battery has no questions';
  }
  for (const [id, question] of entries) {
    const problem = checkQuestion(id, question);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

/**
 * The wire shape names the discriminator `type` and this package names it
 * `kind`. Both are accepted so one validator covers a live response and a
 * recorded one.
 */
function kindOf(record: Record<string, unknown>): unknown {
  return record['kind'] ?? record['type'];
}

function checkAnswer(id: string, question: Question, raw: unknown): Answer | string {
  if (!isRecord(raw)) {
    return `answer "${id}" is not an object`;
  }
  if (kindOf(raw) !== question.kind) {
    // What the answer called itself is not repeated here. It is a string the
    // server picked, and this line is bound for the audit log.
    return `answer "${id}" is not a ${question.kind} answer`;
  }

  if (question.kind === 'noul') {
    const noul = raw['noul'];
    if (!isProbability(noul)) {
      return `answer "${id}" has no probability`;
    }
    return { kind: 'noul', noul };
  }

  const confidence = raw['confidence'];
  if (!isProbability(confidence)) {
    return `answer "${id}" has no confidence`;
  }

  if (question.kind === 'score') {
    const score = raw['score'];
    const top = question.criteria.length - 1;
    // NaN passes both comparisons, so finiteness is checked on its own here.
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > top) {
      return `answer "${id}" scores outside its rubric`;
    }
    return { kind: 'score', score, confidence };
  }

  const choice = raw['choice'];
  if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) {
    return `answer "${id}" picks an outcome the question did not offer`;
  }
  const reported = raw['probabilities'];
  if (!isRecord(reported)) {
    return `answer "${id}" has no probabilities`;
  }
  const probabilities: [string, number][] = [];
  for (const outcome of Object.keys(question.criteria)) {
    const probability = reported[outcome];
    if (!isProbability(probability)) {
      return `answer "${id}" has no probability for "${outcome}"`;
    }
    probabilities.push([outcome, probability]);
  }
  return {
    kind: 'choice',
    choice,
    confidence,
    // Built from the outcomes the question offered, so a probability reported
    // for anything else is dropped rather than carried along.
    probabilities: Object.fromEntries(probabilities),
  };
}

/**
 * Answers for exactly the ids the battery asked about, or the first problem
 * found. Ids the battery did not ask about are dropped rather than refused, so
 * a backend that reports something extra one day does not break a screen.
 */
export function validateAnswers<B extends Battery>(battery: B, raw: unknown): Validation<B> {
  const problem = validateBattery(battery);
  if (problem !== undefined) {
    return { ok: false, problem };
  }
  if (!isRecord(raw)) {
    return { ok: false, problem: 'the answers are not an object' };
  }
  const answers: [string, Answer][] = [];
  for (const [id, question] of Object.entries(battery)) {
    if (!Object.hasOwn(raw, id)) {
      return { ok: false, problem: `answer "${id}" is missing` };
    }
    const checked = checkAnswer(id, question, raw[id]);
    if (typeof checked === 'string') {
      return { ok: false, problem: checked };
    }
    answers.push([id, checked]);
  }
  // One answer per id, each checked against its own question, which is the
  // whole of what the mapped type claims. `fromEntries` rather than assignment,
  // so an id spelled `__proto__` lands as an own property instead of reaching
  // the prototype setter and vanishing.
  return { ok: true, answers: Object.fromEntries(answers) as AnswersFor<B> };
}
