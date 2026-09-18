import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CALL_SEVERITY,
  DESTRUCTIVE,
  EXFILTRATION,
  INSTRUCTS_READER,
  NO_BLOCK,
  POSTRESULT_MEASURED,
  PRECALL_MEASURED,
  RESULT_SEVERITY,
  whichBlock,
} from './questions.js';
import type { NoulQuestion, ScoreQuestion } from '../backends/index.js';

/**
 * The harness that produced the README's numbers. Reading it here is the only
 * thing that makes "the wording is what was measured" a checked claim rather
 * than a promise, so this test depends on the file on purpose.
 */
const HARNESS = readFileSync(new URL('../../bench/src/run.py', import.meta.url), 'utf8');

const measuredNoul = (question: NoulQuestion): string[] => [
  question.instructions,
  ...(question.criteria?.true === undefined ? [] : [question.criteria.true]),
  ...(question.criteria?.false === undefined ? [] : [question.criteria.false]),
];

const measuredScore = (question: ScoreQuestion): string[] => [
  question.instructions,
  ...question.criteria,
];

describe('the measured wording is the wording that ships', () => {
  it.each([
    ['destructive', measuredNoul(DESTRUCTIVE)],
    ['exfiltration', measuredNoul(EXFILTRATION)],
    ['call severity', measuredScore(CALL_SEVERITY)],
    ['instructs_reader', measuredNoul(INSTRUCTS_READER)],
    ['result severity', measuredScore(RESULT_SEVERITY)],
  ])('%s says exactly what the harness sent', (_name, strings) => {
    expect(strings.length).toBeGreaterThan(1);
    for (const text of strings) {
      expect(HARNESS).toContain(text);
    }
  });

  it('keeps the criteria on the questions the harness gave criteria to', () => {
    expect(DESTRUCTIVE.criteria).toBeDefined();
    expect(EXFILTRATION.criteria).toBeDefined();
    expect(INSTRUCTS_READER.criteria).toBeDefined();
  });

  it('keeps the rubrics at the four levels the decision rules label', () => {
    expect(CALL_SEVERITY.criteria).toHaveLength(4);
    expect(RESULT_SEVERITY.criteria).toHaveLength(4);
  });

  it('does not ship the question that was measured and dropped', () => {
    expect(HARNESS).toContain('demands_action');
    expect(Object.keys(POSTRESULT_MEASURED)).toEqual(['instructs_reader', 'severity']);
  });

  it('sends the measured pre-call questions in the order the harness sent them', () => {
    expect(Object.keys(PRECALL_MEASURED)).toEqual(['destructive', 'exfiltration', 'severity']);
  });
});

describe('whichBlock', () => {
  it('offers every block it was given and nothing else', () => {
    expect(Object.keys(whichBlock([0, 1, 2]).criteria)).toEqual(['0', '1', '2', NO_BLOCK]);
  });

  it('keeps the numbering of the whole result, not of the chunk', () => {
    expect(Object.keys(whichBlock([7, 8]).criteria)).toEqual(['7', '8', NO_BLOCK]);
  });

  it('describes only the outcome that needs describing', () => {
    const criteria = whichBlock([0]).criteria;
    expect(criteria['0']).toBeNull();
    expect(criteria[NO_BLOCK]).toBe('No block attempts to instruct the reader.');
  });
});
