import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPreCallScreen, readCallAnswers } from './precall.js';
import { DESTRUCTIVE_CALL_INPUT } from './recorded.js';

const CASES = readFileSync(new URL('../../bench/src/precall_cases.py', import.meta.url), 'utf8');

describe('the pre-call request', () => {
  it('is field for field what the harness sent, when nothing else is configured', () => {
    const screen = buildPreCallScreen(DESTRUCTIVE_CALL_INPUT);

    expect(JSON.stringify(screen.state)).toBe(
      '{"tool":{"name":"execute_command","description":"Run a shell command"},' +
        '"arguments":{"command":"rm -rf ~/"}}',
    );
  });

  it('builds the state the harness built, which is the shape the numbers are for', () => {
    // The harness writes the state inline. If that line changes, the request the
    // README's numbers describe is no longer the request this builds.
    expect(CASES).toContain(
      '"state": {"tool": {"name": tool, "description": desc}, "arguments": args}',
    );
  });

  it('asks the measured questions first, in the order they were measured', () => {
    const screen = buildPreCallScreen(DESTRUCTIVE_CALL_INPUT);

    expect(Object.keys(screen.battery)).toEqual([
      'destructive',
      'exfiltration',
      'severity',
      'secret_in_args',
    ]);
  });

  it('carries a policy and asks about it only when there is one', () => {
    const without = buildPreCallScreen(DESTRUCTIVE_CALL_INPUT);
    expect(without.state.policy).toBeUndefined();
    expect(Object.hasOwn(without.battery, 'policy_violation')).toBe(false);

    const withPolicy = buildPreCallScreen({
      ...DESTRUCTIVE_CALL_INPUT,
      policy: 'This agent must never force-push.',
    });
    expect(withPolicy.state.policy).toBe('This agent must never force-push.');
    expect(Object.hasOwn(withPolicy.battery, 'policy_violation')).toBe(true);
  });

  it('carries a task and asks about it only when there is one', () => {
    const screen = buildPreCallScreen({
      ...DESTRUCTIVE_CALL_INPUT,
      task: 'Fix the broken links on the getting-started page',
    });

    expect(screen.state.task).toBe('Fix the broken links on the getting-started page');
    expect(Object.keys(screen.battery)).toEqual([
      'destructive',
      'exfiltration',
      'severity',
      'secret_in_args',
      'off_task',
    ]);
  });

  it.each([[''], ['   ']])(
    'treats %o as no policy and no task, rather than as an empty one',
    (blank) => {
      const screen = buildPreCallScreen({
        ...DESTRUCTIVE_CALL_INPUT,
        policy: blank,
        task: blank,
      });

      expect(Object.keys(screen.state)).toEqual(['tool', 'arguments']);
      expect(Object.keys(screen.battery)).not.toContain('off_task');
      expect(Object.keys(screen.battery)).not.toContain('policy_violation');
    },
  );

  it('puts policy before task, and both after the call itself', () => {
    const screen = buildPreCallScreen({
      ...DESTRUCTIVE_CALL_INPUT,
      policy: 'no force-pushing',
      task: 'fix the links',
    });

    expect(Object.keys(screen.state)).toEqual(['tool', 'arguments', 'policy', 'task']);
  });

  it('omits a description that is not there rather than sending an empty one', () => {
    const screen = buildPreCallScreen({ tool: { name: 'fetch' }, redacted_arguments: {} });

    expect(JSON.stringify(screen.state)).toBe('{"tool":{"name":"fetch"},"arguments":{}}');
  });

  it('shows the server annotations as something the server claims', () => {
    const screen = buildPreCallScreen({
      tool: { name: 'fetch', description: 'Fetch a URL', annotations: { readOnlyHint: true } },
      redacted_arguments: { url: 'https://example.com' },
    });

    expect(Object.keys(screen.state.tool)).toEqual(['name', 'description', 'annotations']);
    expect(screen.state.tool.annotations).toEqual({ readOnlyHint: true });
    // A hint never removes a question. The MCP spec says a client treats these
    // as untrusted unless it trusts the server.
    expect(Object.keys(screen.battery)).toContain('destructive');
  });

  it('omits annotations that carry nothing', () => {
    const screen = buildPreCallScreen({
      tool: { name: 'fetch', annotations: {} },
      redacted_arguments: {},
    });

    expect(Object.hasOwn(screen.state.tool, 'annotations')).toBe(false);
  });

  it('sends the arguments it was handed, which are the redacted ones', () => {
    const screen = buildPreCallScreen({
      tool: { name: 'fetch' },
      redacted_arguments: { token: '[REDACTED:github_token]' },
    });

    expect(screen.state.arguments).toEqual({ token: '[REDACTED:github_token]' });
  });
});

describe('readCallAnswers', () => {
  it('reads every question the battery can ask', () => {
    expect(
      readCallAnswers({
        destructive: { kind: 'noul', noul: 0.9 },
        exfiltration: { kind: 'noul', noul: 0.1 },
        secret_in_args: { kind: 'noul', noul: 0.2 },
        policy_violation: { kind: 'noul', noul: 0.3 },
        off_task: { kind: 'noul', noul: 0.4 },
        severity: { kind: 'score', score: 2.5, confidence: 0.8 },
      }),
    ).toEqual({
      destructive: 0.9,
      exfiltration: 0.1,
      secret_in_args: 0.2,
      policy_violation: 0.3,
      off_task: 0.4,
      severity: { score: 2.5, confidence: 0.8 },
    });
  });

  it('leaves a question that was not asked absent rather than zero', () => {
    const answers = readCallAnswers({ destructive: { kind: 'noul', noul: 0.9 } });

    expect(answers).toEqual({ destructive: 0.9 });
    expect(Object.hasOwn(answers, 'off_task')).toBe(false);
  });

  it('ignores an answer of the wrong kind rather than reading a number off it', () => {
    expect(
      readCallAnswers({
        destructive: { kind: 'score', score: 3, confidence: 1 },
        severity: { kind: 'noul', noul: 0.5 },
      }),
    ).toEqual({});
  });

  it('reads nothing out of nothing', () => {
    expect(readCallAnswers({})).toEqual({});
  });
});
