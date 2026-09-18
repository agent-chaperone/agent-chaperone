import { describe, expect, it } from 'vitest';
import type { Battery } from './types.js';
import { validateAnswers, validateBattery } from './validate.js';

const noul: Battery = { destructive: { kind: 'noul', instructions: 'deletes?' } };
const score: Battery = {
  severity: { kind: 'score', instructions: 'how bad?', criteria: ['none', 'some', 'a lot'] },
};
const choice: Battery = {
  target: { kind: 'choice', instructions: 'where?', criteria: { local: 'here', remote: null } },
};

describe('validateBattery', () => {
  it('accepts a battery that can be asked', () => {
    expect(validateBattery({ ...noul, ...score, ...choice })).toBeUndefined();
  });

  it('refuses an empty battery before anything is sent', () => {
    expect(validateBattery({})).toBe('the battery has no questions');
  });

  it('refuses a question with nothing to answer', () => {
    expect(validateBattery({ a: { kind: 'noul', instructions: '' } })).toBe(
      'question "a" has no instructions',
    );
    expect(validateBattery({ a: { kind: 'noul', instructions: '   ' } })).toBe(
      'question "a" has no instructions',
    );
  });

  it('refuses a kind of question this package does not ask', () => {
    const typo = { target: { kind: 'choise', instructions: 'where?', criteria: ['a', 'b'] } };
    expect(validateBattery(typo as unknown as Battery)).toBe(
      'question "target" is not a kind of question this package asks',
    );
  });

  it.each([[null], [undefined], ['deletes?'], [['deletes?']]])(
    'refuses %o in place of a question',
    (question) => {
      expect(validateBattery({ a: question } as unknown as Battery)).toBe(
        'question "a" is not an object',
      );
    },
  );

  it.each([[null], [undefined], [[]], ['everything']])(
    'refuses %o in place of a battery rather than throwing',
    (battery) => {
      expect(validateBattery(battery as unknown as Battery)).toBe('the battery is not an object');
    },
  );

  it('refuses instructions that are not text', () => {
    expect(validateBattery({ a: { kind: 'noul', instructions: null } } as unknown as Battery)).toBe(
      'question "a" has no instructions',
    );
  });

  it('refuses a rubric that is not a list', () => {
    expect(
      validateBattery({
        a: { kind: 'score', instructions: 'x', criteria: 'ab' },
      } as unknown as Battery),
    ).toContain('at least two levels');
  });

  it('refuses choice outcomes that are a list rather than a map', () => {
    expect(
      validateBattery({
        a: { kind: 'choice', instructions: 'x', criteria: ['local', 'remote'] },
      } as unknown as Battery),
    ).toContain('at least two outcomes');
  });

  it('refuses a rubric with only one level', () => {
    expect(
      validateBattery({ a: { kind: 'score', instructions: 'how bad?', criteria: ['none'] } }),
    ).toContain('at least two levels');
  });

  it('refuses a choice with only one outcome', () => {
    expect(
      validateBattery({ a: { kind: 'choice', instructions: 'where?', criteria: { local: null } } }),
    ).toContain('at least two outcomes');
  });
});

describe('validateAnswers', () => {
  it('keeps the ids the questions were asked under', () => {
    const checked = validateAnswers(noul, { destructive: { kind: 'noul', noul: 0.8 } });
    expect(checked).toEqual({ ok: true, answers: { destructive: { kind: 'noul', noul: 0.8 } } });
  });

  it('accepts the wire spelling of the discriminator', () => {
    const checked = validateAnswers(noul, { destructive: { type: 'noul', noul: 0.8 } });
    expect(checked.ok).toBe(true);
  });

  it('refuses answers that are not an object', () => {
    expect(validateAnswers(noul, 'yes')).toEqual({
      ok: false,
      problem: 'the answers are not an object',
    });
  });

  it('refuses a missing id rather than reading undefined into a threshold', () => {
    expect(validateAnswers(noul, {})).toEqual({
      ok: false,
      problem: 'answer "destructive" is missing',
    });
  });

  it('refuses an id answered with the wrong kind of answer', () => {
    const checked = validateAnswers(noul, {
      destructive: { kind: 'score', score: 2, confidence: 1 },
    });
    expect(checked).toEqual({ ok: false, problem: 'answer "destructive" is not a noul answer' });
  });

  it('refuses a probability that is not a number', () => {
    expect(validateAnswers(noul, { destructive: { kind: 'noul', noul: '0.8' } })).toEqual({
      ok: false,
      problem: 'answer "destructive" has no probability',
    });
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s as a probability',
    (value) => {
      expect(validateAnswers(noul, { destructive: { kind: 'noul', noul: value } }).ok).toBe(false);
    },
  );

  it('accepts the ends of the probability range', () => {
    expect(validateAnswers(noul, { destructive: { kind: 'noul', noul: 0 } }).ok).toBe(true);
    expect(validateAnswers(noul, { destructive: { kind: 'noul', noul: 1 } }).ok).toBe(true);
  });

  it('keeps a score between the levels, because the API reports an expectation', () => {
    const checked = validateAnswers(score, {
      severity: { kind: 'score', score: 1.5, confidence: 0.6 },
    });
    expect(checked).toEqual({
      ok: true,
      answers: { severity: { kind: 'score', score: 1.5, confidence: 0.6 } },
    });
  });

  it('refuses a score past the end of its own rubric', () => {
    expect(
      validateAnswers(score, { severity: { kind: 'score', score: 3, confidence: 0.6 } }),
    ).toEqual({ ok: false, problem: 'answer "severity" scores outside its rubric' });
  });

  it('refuses a negative score', () => {
    expect(
      validateAnswers(score, { severity: { kind: 'score', score: -1, confidence: 0.6 } }).ok,
    ).toBe(false);
  });

  it('refuses a score without a confidence', () => {
    expect(validateAnswers(score, { severity: { kind: 'score', score: 1 } })).toEqual({
      ok: false,
      problem: 'answer "severity" has no confidence',
    });
  });

  it('accepts a choice with a probability for every outcome', () => {
    const checked = validateAnswers(choice, {
      target: {
        kind: 'choice',
        choice: 'remote',
        confidence: 0.7,
        probabilities: { local: 0.3, remote: 0.7 },
      },
    });
    expect(checked).toEqual({
      ok: true,
      answers: {
        target: {
          kind: 'choice',
          choice: 'remote',
          confidence: 0.7,
          probabilities: { local: 0.3, remote: 0.7 },
        },
      },
    });
  });

  it('refuses an outcome the question never offered', () => {
    expect(
      validateAnswers(choice, {
        target: {
          kind: 'choice',
          choice: 'elsewhere',
          confidence: 0.7,
          probabilities: { local: 0.3, remote: 0.7 },
        },
      }),
    ).toEqual({
      ok: false,
      problem: 'answer "target" picks an outcome the question did not offer',
    });
  });

  it('refuses an outcome inherited from the prototype chain', () => {
    expect(
      validateAnswers(choice, {
        target: {
          kind: 'choice',
          choice: 'toString',
          confidence: 0.7,
          probabilities: { local: 0.3, remote: 0.7 },
        },
      }).ok,
    ).toBe(false);
  });

  it('refuses a missing probability for an outcome that was offered', () => {
    expect(
      validateAnswers(choice, {
        target: { kind: 'choice', choice: 'remote', confidence: 0.7, probabilities: { remote: 1 } },
      }),
    ).toEqual({ ok: false, problem: 'answer "target" has no probability for "local"' });
  });

  it('refuses probabilities that are not an object', () => {
    expect(
      validateAnswers(choice, {
        target: { kind: 'choice', choice: 'remote', confidence: 0.7, probabilities: [1, 0] },
      }),
    ).toEqual({ ok: false, problem: 'answer "target" has no probabilities' });
  });

  it('drops an answer to a question that was not asked', () => {
    const checked = validateAnswers(noul, {
      destructive: { kind: 'noul', noul: 0.2 },
      something_new: { kind: 'noul', noul: 0.9 },
    });
    expect(checked).toEqual({ ok: true, answers: { destructive: { kind: 'noul', noul: 0.2 } } });
  });

  it('does not accept an answer inherited from the prototype chain', () => {
    const raw = Object.create({ destructive: { kind: 'noul', noul: 0.5 } }) as object;
    expect(validateAnswers(noul, raw)).toEqual({
      ok: false,
      problem: 'answer "destructive" is missing',
    });
  });

  it('refuses an answer that is an array', () => {
    expect(validateAnswers(noul, { destructive: [] })).toEqual({
      ok: false,
      problem: 'answer "destructive" is not an object',
    });
  });
});
