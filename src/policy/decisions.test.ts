import { describe, expect, it } from 'vitest';
import {
  assessSeverity,
  decidePostResult,
  decidePreCall,
  shouldScreen,
  type CallAnswers,
  type ResultAnswers,
} from './decisions.js';
import { defaultPolicy, parsePolicy, type Policy } from './schema.js';

const enforcing = (extra = ''): Policy => parsePolicy(`mode: enforce\n${extra}`);
const call = (answers: CallAnswers, policy = enforcing()) =>
  decidePreCall(answers, {}, policy).intended;
const result = (answers: ResultAnswers, policy = enforcing()) =>
  decidePostResult(answers, {}, policy).intended;

describe('pre-call, in the order the design sets out', () => {
  it('forwards when nothing reaches a threshold', () => {
    expect(call({ destructive: 0.1, exfiltration: 0.1, policy_violation: 0.1 })).toEqual({
      kind: 'forward',
    });
  });

  it('blocks on the deny list before asking anything else', () => {
    const decision = decidePreCall(
      { destructive: 0.99, exfiltration: 0.99 },
      { denied_by: 'delete_*' },
      enforcing(),
    );
    expect(decision.intended).toEqual({ kind: 'block', reason: 'deny-list', detail: 'delete_*' });
  });

  it('blocks a tool that is not on an allow list', () => {
    const decision = decidePreCall({}, { outside_allow_list: true }, enforcing());
    expect(decision.intended).toEqual({ kind: 'block', reason: 'outside-allow-list' });
  });

  it('prefers the deny list over the allow list, so the reason is the specific one', () => {
    const decision = decidePreCall({}, { denied_by: 'rm', outside_allow_list: true }, enforcing());
    expect(decision.intended).toMatchObject({ reason: 'deny-list' });
  });

  it('holds on exfiltration ahead of everything else the model answered', () => {
    expect(call({ exfiltration: 0.9, destructive: 0.99, policy_violation: 0.99 })).toMatchObject({
      kind: 'hold',
      reason: 'exfiltration',
    });
  });

  it('treats a secret in the arguments as the same concern, at the same threshold', () => {
    expect(call({ secret_in_args: 0.6 })).toMatchObject({ reason: 'secret-in-arguments' });
    expect(call({ secret_in_args: 0.59 })).toEqual({ kind: 'forward' });
  });

  it('falls through exfiltration to destructive, then policy, then off task', () => {
    // Each earlier question answers just below its threshold, so the fall-through
    // is exercised rather than sidestepped by leaving the question out.
    expect(
      call({ exfiltration: 0.59, destructive: 0.8, policy_violation: 0.99, off_task: 0.99 }),
    ).toMatchObject({ reason: 'destructive', probability: 0.8 });
    expect(
      call({ exfiltration: 0.59, destructive: 0.69, policy_violation: 0.8, off_task: 0.99 }),
    ).toMatchObject({ reason: 'policy', probability: 0.8 });
    expect(
      call({ exfiltration: 0.59, destructive: 0.69, policy_violation: 0.69, off_task: 0.95 }),
    ).toMatchObject({ reason: 'off-task', probability: 0.95 });
  });

  it('reports the probability of the question that fired, on every branch', () => {
    expect(call({ exfiltration: 0.61 })).toMatchObject({
      reason: 'exfiltration',
      probability: 0.61,
    });
    expect(call({ secret_in_args: 0.62 })).toMatchObject({
      reason: 'secret-in-arguments',
      probability: 0.62,
    });
    expect(call({ destructive: 0.71 })).toMatchObject({ reason: 'destructive', probability: 0.71 });
    expect(call({ policy_violation: 0.72 })).toMatchObject({ reason: 'policy', probability: 0.72 });
    expect(call({ off_task: 0.91 })).toMatchObject({ reason: 'off-task', probability: 0.91 });
    expect(result({ exposes_secret: 0.75 })).toMatchObject({ probability: 0.75 });
    expect(result({ instructs_reader: 0.55 })).toMatchObject({ probability: 0.55 });
  });

  it('places the allow list second, after the deny list and before every answer', () => {
    expect(
      decidePreCall({ exfiltration: 0.99 }, { outside_allow_list: true }, enforcing()).intended,
    ).toMatchObject({ kind: 'block', reason: 'outside-allow-list' });
    expect(
      decidePreCall({ destructive: 0.99 }, { outside_allow_list: true }, enforcing()).intended,
    ).toMatchObject({ reason: 'outside-allow-list' });
  });

  it('ignores a question the model was never asked', () => {
    expect(call({ destructive: undefined, off_task: undefined })).toEqual({ kind: 'forward' });
  });

  it('reports the probability that caused the hold', () => {
    expect(call({ destructive: 0.83 })).toMatchObject({ probability: 0.83 });
  });
});

describe('the boundary at each threshold', () => {
  const cases: readonly {
    readonly name: string;
    readonly at: CallAnswers;
    readonly below: CallAnswers;
  }[] = [
    { name: 'hold_exfiltration', at: { exfiltration: 0.6 }, below: { exfiltration: 0.5999 } },
    { name: 'hold_destructive', at: { destructive: 0.7 }, below: { destructive: 0.6999 } },
    { name: 'hold_policy', at: { policy_violation: 0.7 }, below: { policy_violation: 0.6999 } },
    { name: 'hold_off_task', at: { off_task: 0.9 }, below: { off_task: 0.8999 } },
  ];

  for (const { name, at, below } of cases) {
    it(`${name} fires exactly at the threshold and not just below it`, () => {
      expect(call(at).kind).toBe('hold');
      expect(call(below).kind).toBe('forward');
    });
  }

  it('annotate and quarantine fire exactly at their thresholds', () => {
    expect(result({ instructs_reader: 0.5 }).kind).toBe('annotate');
    expect(result({ instructs_reader: 0.4999 }).kind).toBe('pass');
    const harmful = { score: 2, confidence: 0.9 };
    expect(result({ instructs_reader: 0.8, severity: harmful }).kind).toBe('quarantine');
    expect(result({ instructs_reader: 0.7999, severity: harmful }).kind).toBe('annotate');
  });

  it('redaction fires exactly at its threshold', () => {
    expect(result({ exposes_secret: 0.7 }).kind).toBe('redact');
    expect(result({ exposes_secret: 0.6999 }).kind).toBe('pass');
  });

  it('the harmful severity level is a boundary too', () => {
    expect(result({ instructs_reader: 0.9, severity: { score: 1.5, confidence: 0.9 } }).kind).toBe(
      'quarantine',
    );
    expect(
      result({ instructs_reader: 0.9, severity: { score: 1.4999, confidence: 0.9 } }).kind,
    ).toBe('annotate');
  });

  const moved: readonly {
    readonly key: string;
    readonly section: 'call' | 'result';
    readonly probe: (policy: Policy) => string;
  }[] = [
    { key: 'hold_destructive', section: 'call', probe: (p) => call({ destructive: 0.3 }, p).kind },
    {
      key: 'hold_exfiltration',
      section: 'call',
      probe: (p) => call({ exfiltration: 0.3 }, p).kind,
    },
    { key: 'hold_policy', section: 'call', probe: (p) => call({ policy_violation: 0.3 }, p).kind },
    { key: 'hold_off_task', section: 'call', probe: (p) => call({ off_task: 0.3 }, p).kind },
    {
      key: 'annotate_instructs',
      section: 'result',
      probe: (p) => result({ instructs_reader: 0.3 }, p).kind,
    },
    {
      key: 'redact_secret',
      section: 'result',
      probe: (p) => result({ exposes_secret: 0.3 }, p).kind,
    },
  ];

  for (const { key, section, probe } of moved) {
    it(`reads ${key} from the policy rather than a constant`, () => {
      const lowered = enforcing(`thresholds:\n  ${section}:\n    ${key}: 0.2\n`);
      expect(probe(lowered)).not.toBe(section === 'call' ? 'forward' : 'pass');
      expect(probe(enforcing())).toBe(section === 'call' ? 'forward' : 'pass');
    });
  }

  it('reads quarantine_instructs from the policy', () => {
    const harmful = { score: 2, confidence: 0.9 };
    // Annotate has to come down too: a policy where annotate sits above
    // quarantine is rejected, because annotate could then never be reached.
    const lowered = enforcing(
      'thresholds:\n  result:\n    annotate_instructs: 0.2\n    quarantine_instructs: 0.3\n',
    );
    expect(result({ instructs_reader: 0.4, severity: harmful }, lowered).kind).toBe('quarantine');
    expect(result({ instructs_reader: 0.4, severity: harmful }).kind).toBe('pass');
  });

  it('reads harmful_severity_level from the policy', () => {
    const lowered = enforcing('thresholds:\n  result:\n    harmful_severity_level: 0.5\n');
    const mild = { instructs_reader: 0.9, severity: { score: 1, confidence: 0.9 } };
    expect(result(mild, lowered).kind).toBe('quarantine');
    expect(result(mild).kind).toBe('annotate');
  });

  it('reads uncertain_severity_confidence from the policy', () => {
    const lenient = enforcing('thresholds:\n  uncertain_severity_confidence: 0.1\n');
    const answers = { destructive: 0.9, severity: { score: 2, confidence: 0.3 } };
    expect(call(answers, lenient)).toMatchObject({ severity: { uncertain: false } });
    expect(call(answers)).toMatchObject({ severity: { uncertain: true } });
  });
});

describe('post-result, in the order the design sets out', () => {
  it('passes content that reaches nothing', () => {
    expect(result({ instructs_reader: 0.2, exposes_secret: 0.1 })).toEqual({ kind: 'pass' });
  });

  it('redacts a secret before considering anything else', () => {
    expect(result({ exposes_secret: 0.9, instructs_reader: 0.99 })).toMatchObject({
      kind: 'redact',
    });
  });

  it('quarantines an instruction only when the harm would be real', () => {
    expect(
      result({ instructs_reader: 0.9, severity: { score: 2.4, confidence: 0.9 } }),
    ).toMatchObject({
      kind: 'quarantine',
    });
    expect(
      result({ instructs_reader: 0.9, severity: { score: 0.4, confidence: 0.9 } }),
    ).toMatchObject({
      kind: 'annotate',
    });
  });

  it('annotates rather than quarantining when severity was never asked', () => {
    expect(result({ instructs_reader: 0.99 })).toMatchObject({ kind: 'annotate' });
  });

  it('carries the block the model pointed at', () => {
    expect(result({ instructs_reader: 0.9, which_block: 3 })).toMatchObject({ block: 3 });
  });

  it('never points a redaction at a block, because nothing locates a secret', () => {
    const decision = decidePostResult(
      { exposes_secret: 0.9, instructs_reader: 0.99, which_block: 3 },
      { hidden_regions: [{ block: 7, kind: 'html_comment' }] },
      enforcing(),
    );
    expect(decision.intended).toEqual({ kind: 'redact', probability: 0.9 });
  });

  it('prefers the block the model pointed at over the one the rules flagged', () => {
    const decision = decidePostResult(
      { instructs_reader: 0.9, which_block: 2 },
      { hidden_regions: [{ block: 7, kind: 'html_comment' }] },
      enforcing(),
    );
    expect(decision.intended).toMatchObject({ block: 2 });
  });

  it('falls back to the block the deterministic layer flagged', () => {
    const decision = decidePostResult(
      { instructs_reader: 0.9 },
      { hidden_regions: [{ block: 7, kind: 'html_comment' }] },
      enforcing(),
    );
    expect(decision.intended).toMatchObject({ block: 7 });
  });
});

describe('severity as a label', () => {
  const floor = defaultPolicy().thresholds.uncertain_severity_confidence;

  const label = (score: number): string | undefined =>
    assessSeverity({ score, confidence: 1 }, floor)?.label;

  it('names each level, at the boundary and just below it', () => {
    expect(label(0)).toBe('none');
    expect(label(0.4999)).toBe('none');
    expect(label(0.5)).toBe('low');
    expect(label(1.4999)).toBe('low');
    expect(label(1.5)).toBe('high');
    expect(label(2.4999)).toBe('high');
    expect(label(2.5)).toBe('critical');
    expect(label(3)).toBe('critical');
  });

  it('marks a spread distribution as uncertain, so a hold reads as asking', () => {
    expect(assessSeverity({ score: 2, confidence: 0.4999 }, floor)?.uncertain).toBe(true);
    expect(assessSeverity({ score: 2, confidence: 0.5 }, floor)?.uncertain).toBe(false);
  });

  it('is absent when the question was not asked', () => {
    expect(assessSeverity(undefined, floor)).toBeUndefined();
  });

  it('carries the assessment onto a quarantine, not just the tier comparison', () => {
    expect(
      result({ instructs_reader: 0.9, severity: { score: 2.9, confidence: 0.2 } }),
    ).toMatchObject({
      kind: 'quarantine',
      severity: { label: 'critical', score: 2.9, uncertain: true },
    });
  });

  it('labels the hold without gating it', () => {
    const held = call({ destructive: 0.9, severity: { score: 2.8, confidence: 0.9 } });
    expect(held).toMatchObject({ kind: 'hold', severity: { label: 'critical', uncertain: false } });
    const stillHeld = call({ destructive: 0.9, severity: { score: 0, confidence: 0.9 } });
    expect(stillHeld.kind).toBe('hold');
  });
});

describe('mode', () => {
  it('records the decision and applies nothing in shadow', () => {
    const decision = decidePreCall({ destructive: 0.99 }, {}, parsePolicy('mode: shadow\n'));
    expect(decision.intended).toMatchObject({ kind: 'hold' });
    expect(decision.applied).toEqual({ kind: 'forward' });
  });

  it('passes results through in shadow while still recording the quarantine', () => {
    const decision = decidePostResult(
      { instructs_reader: 0.99, severity: { score: 3, confidence: 1 } },
      {},
      parsePolicy('mode: shadow\n'),
    );
    expect(decision.intended).toMatchObject({ kind: 'quarantine' });
    expect(decision.applied).toEqual({ kind: 'pass' });
  });

  it('applies what it decides in enforce and in strict', () => {
    for (const mode of ['enforce', 'strict']) {
      const decision = decidePreCall({ destructive: 0.99 }, {}, parsePolicy(`mode: ${mode}\n`));
      expect(decision.applied).toEqual(decision.intended);
    }
  });
});

describe('screening a server at all', () => {
  const policy = parsePolicy('servers:\n  internal-docs:\n    screen_results: false\n');

  it('screens a server that says nothing', () => {
    expect(shouldScreen(policy, 'filesystem', 'calls')).toBe(true);
    expect(shouldScreen(policy, 'filesystem', 'results')).toBe(true);
  });

  it('does not read a server name through the prototype chain', () => {
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(shouldScreen(policy, name, 'calls')).toBe(true);
      expect(shouldScreen(policy, name, 'results')).toBe(true);
    }
  });

  it('honours a server that opts out of one side only', () => {
    expect(shouldScreen(policy, 'internal-docs', 'results')).toBe(false);
    expect(shouldScreen(policy, 'internal-docs', 'calls')).toBe(true);
  });
});
