import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { answered, createFakeBackend } from '../backends/index.js';
import { assessSeverity, decidePostResult, decidePreCall, parsePolicy } from '../policy/index.js';
import type { Policy } from '../policy/index.js';
import { buildPreCallScreen, readCallAnswers } from './precall.js';
import { mergeResultAnswers, readResultAnswers } from './postresult.js';
import type { RecordedResponse } from './recorded.js';
import {
  BENIGN_CALL,
  BENIGN_CALL_INPUT,
  CLEAN_RESULT,
  DESTRUCTIVE_CALL,
  DESTRUCTIVE_CALL_INPUT,
  EXFILTRATING_CALL,
  EXFILTRATING_CALL_INPUT,
  INJECTED_RESULT,
  UNCERTAIN_CALL,
  UNCERTAIN_CALL_INPUT,
} from './recorded.js';

const enforcing: Policy = parsePolicy('mode: enforce');
const uncertainBelow = enforcing.thresholds.uncertain_severity_confidence;

const callAction = (recorded: RecordedResponse) =>
  decidePreCall(readCallAnswers(recorded.answers), {}, enforcing).intended;

const resultAction = (recorded: RecordedResponse) =>
  decidePostResult(readResultAnswers(recorded.answers), {}, enforcing).intended;

describe('what the model actually said, carried through to a decision', () => {
  it('forwards a directory listing', () => {
    expect(callAction(BENIGN_CALL)).toEqual({ kind: 'forward' });
  });

  it('holds a recursive delete of the home directory', () => {
    expect(callAction(DESTRUCTIVE_CALL)).toMatchObject({ kind: 'hold' });
  });

  it('holds a call that pipes the environment file to a webhook', () => {
    // Destructive reads below its threshold on this one. The exfiltration answer
    // is what holds it, which is the reason the rules read both.
    expect(readCallAnswers(EXFILTRATING_CALL.answers).destructive).toBeLessThan(0.7);
    expect(callAction(EXFILTRATING_CALL)).toMatchObject({ kind: 'hold' });
  });

  it('passes a paragraph that discusses prompt injection without issuing one', () => {
    expect(resultAction(CLEAN_RESULT)).toEqual({ kind: 'pass' });
  });

  it('quarantines a tool response carrying an attacker instruction', () => {
    expect(resultAction(INJECTED_RESULT)).toMatchObject({ kind: 'quarantine' });
  });

  it('labels a severity the model was not sure about', () => {
    // Deleting a personal document: the score lands between levels, so the
    // nearest one is harmful, but the distribution behind it was spread. The hold
    // this labels should read as the tool asking rather than asserting.
    const severity = assessSeverity(
      readCallAnswers(UNCERTAIN_CALL.answers).severity,
      uncertainBelow,
    );

    expect(severity).toMatchObject({ uncertain: true });
    expect(severity?.score).toBeLessThan(2);
  });

  it('states a severity the model was sure about', () => {
    const severity = assessSeverity(
      readCallAnswers(DESTRUCTIVE_CALL.answers).severity,
      uncertainBelow,
    );

    expect(severity).toMatchObject({ label: 'critical', uncertain: false });
  });
});

describe('the whole chain, from a tool call to an action', () => {
  it.each([
    ['a benign call', BENIGN_CALL_INPUT, BENIGN_CALL, 'forward'],
    ['a destructive call', DESTRUCTIVE_CALL_INPUT, DESTRUCTIVE_CALL, 'hold'],
    ['an exfiltrating call', EXFILTRATING_CALL_INPUT, EXFILTRATING_CALL, 'hold'],
    ['an uncertain call', UNCERTAIN_CALL_INPUT, UNCERTAIN_CALL, 'hold'],
  ])('screens %s the way the recorded run answered it', async (_name, input, recorded, kind) => {
    const screen = buildPreCallScreen(input);
    const backend = createFakeBackend([
      {
        state: screen.state,
        battery: screen.battery,
        result: answered(recorded.answers, { model: recorded.model }),
      },
    ]);

    // The fake refuses a recording that does not answer the battery it is
    // replayed for, so this passing is itself the check that the request built
    // here is the request the recorded run answered.
    const result = await backend.ask(screen.state, screen.battery);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decidePreCall(readCallAnswers(result.answers), {}, enforcing).intended).toMatchObject({
      kind,
    });
  });

  it('answers every question the shipping battery asks', () => {
    const asked = Object.keys(buildPreCallScreen(DESTRUCTIVE_CALL_INPUT).battery);

    expect(Object.keys(DESTRUCTIVE_CALL.answers).sort()).toEqual([...asked].sort());
  });
});

/**
 * The fixtures claim two things: that these answers came from a named row of the
 * recorded run, and that the calls beside them are the harness's own. Neither is
 * worth anything unless something checks it, because a fixture that drifted would
 * have the repository reporting a judgment the model never made.
 */
describe('where the fixtures came from', () => {
  const CACHE = readFileSync(new URL('../../bench/results/cache.jsonl', import.meta.url), 'utf8');
  const CASES = readFileSync(new URL('../../bench/src/precall_cases.py', import.meta.url), 'utf8');

  const recordFor = (id: string): Record<string, unknown> | undefined => {
    let found: Record<string, unknown> | undefined;
    for (const line of CACHE.split('\n')) {
      if (!line.includes(`"${id}"`)) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // The harness appends, so the last record for an id is the current one.
        if (parsed['id'] === id && parsed['answers'] !== undefined) {
          found = parsed;
        }
      } catch {
        continue;
      }
    }
    return found;
  };

  it.each([
    ['BENIGN_CALL', BENIGN_CALL],
    ['DESTRUCTIVE_CALL', DESTRUCTIVE_CALL],
    ['EXFILTRATING_CALL', EXFILTRATING_CALL],
    ['UNCERTAIN_CALL', UNCERTAIN_CALL],
    ['CLEAN_RESULT', CLEAN_RESULT],
    ['INJECTED_RESULT', INJECTED_RESULT],
  ])('%s matches the row it names in the recorded run', (_name, fixture) => {
    const record = recordFor(fixture.id);
    expect(record).toBeDefined();
    expect(record?.['model']).toBe(fixture.model);

    const recorded = record?.['answers'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(fixture.answers).sort());
    for (const [id, answer] of Object.entries(fixture.answers)) {
      const source = recorded[id];
      if (answer.kind === 'noul') {
        expect(source?.['noul']).toBe(answer.noul);
      } else if (answer.kind === 'score') {
        expect(source?.['score']).toBe(answer.score);
        expect(source?.['confidence']).toBe(answer.confidence);
      } else {
        expect(source?.['choice']).toBe(answer.choice);
      }
    }
  });

  it.each([
    ['BENIGN_CALL', BENIGN_CALL_INPUT],
    ['DESTRUCTIVE_CALL', DESTRUCTIVE_CALL_INPUT],
    ['EXFILTRATING_CALL', EXFILTRATING_CALL_INPUT],
    ['UNCERTAIN_CALL', UNCERTAIN_CALL_INPUT],
  ])('%s is a call the harness actually holds', (_name, input) => {
    expect(CASES).toContain(`"${input.tool.name}"`);
    expect(CASES).toContain(`"${input.tool.description}"`);
    for (const value of Object.values(input.redacted_arguments)) {
      expect(CASES).toContain(String(value));
    }
  });
});

describe('a result split across chunks', () => {
  it('takes the injected chunk as the verdict for the whole result', () => {
    const clean = readResultAnswers(CLEAN_RESULT.answers);
    const injected = readResultAnswers(INJECTED_RESULT.answers);

    const merged = mergeResultAnswers([clean, clean, injected, clean]);

    expect(merged.instructs_reader).toBe(injected.instructs_reader);
    expect(decidePostResult(merged, {}, enforcing).intended).toMatchObject({ kind: 'quarantine' });
  });

  it('leaves a result of only clean chunks alone', () => {
    const clean = readResultAnswers(CLEAN_RESULT.answers);

    expect(
      decidePostResult(mergeResultAnswers([clean, clean, clean]), {}, enforcing).intended,
    ).toEqual({ kind: 'pass' });
  });
});
