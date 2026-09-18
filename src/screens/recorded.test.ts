import { describe, expect, it } from 'vitest';
import { answered, createFakeBackend } from '../backends/index.js';
import { assessSeverity, decidePostResult, decidePreCall, parsePolicy } from '../policy/index.js';
import type { Policy } from '../policy/index.js';
import { buildPreCallScreen, readCallAnswers } from './precall.js';
import { mergeResultAnswers, readResultAnswers } from './postresult.js';
import { PRECALL_MEASURED } from './questions.js';
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
    // Deleting a personal document: the score lands at 1.61, so the nearest
    // level is harmful, but the distribution behind it was spread. The hold this
    // labels should read as the tool asking rather than asserting.
    const severity = assessSeverity(
      readCallAnswers(UNCERTAIN_CALL.answers).severity,
      uncertainBelow,
    );

    expect(severity).toMatchObject({ label: 'high', uncertain: true });
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

/**
 * The recorded run asked the three measured questions. The battery that ships
 * adds the unmeasured ones from the design, so a fixture is replayed against the
 * battery it was actually recorded for. Anything else would be claiming a
 * measurement of a request that was never sent.
 */
describe('the whole chain, from a tool call to an action', () => {
  it.each([
    ['a benign call', BENIGN_CALL_INPUT, BENIGN_CALL, 'forward'],
    ['a destructive call', DESTRUCTIVE_CALL_INPUT, DESTRUCTIVE_CALL, 'hold'],
    ['an exfiltrating call', EXFILTRATING_CALL_INPUT, EXFILTRATING_CALL, 'hold'],
  ])('screens %s the way the recorded run answered it', async (_name, input, recorded, kind) => {
    const state = buildPreCallScreen(input).state;
    const backend = createFakeBackend([
      {
        state,
        battery: PRECALL_MEASURED,
        result: answered(recorded.answers, { model: recorded.model }),
      },
    ]);

    const result = await backend.ask(state, PRECALL_MEASURED);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decidePreCall(readCallAnswers(result.answers), {}, enforcing).intended).toMatchObject({
      kind,
    });
  });

  it('ships every question that was measured, and marks what it adds beyond them', () => {
    const shipped = Object.keys(buildPreCallScreen(DESTRUCTIVE_CALL_INPUT).battery);

    for (const measured of Object.keys(PRECALL_MEASURED)) {
      expect(shipped).toContain(measured);
    }
    // The addition, which the design marks as not yet measured.
    expect(shipped).toEqual([...Object.keys(PRECALL_MEASURED), 'secret_in_args']);
  });

  it('reads a recorded answer even though the battery asks for more than it holds', () => {
    // A question that was not answered stays absent, so an old recording still
    // drives the rules it has answers for instead of failing the whole screen.
    const answers = readCallAnswers(DESTRUCTIVE_CALL.answers);

    expect(Object.hasOwn(answers, 'secret_in_args')).toBe(false);
    expect(answers.destructive).toBeGreaterThan(0.9);
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
