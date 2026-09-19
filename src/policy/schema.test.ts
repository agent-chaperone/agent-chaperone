import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { PolicyError, defaultPolicy, parsePolicy, policyForServer } from './schema.js';

describe('defaults', () => {
  it('gives every threshold a value when the file says nothing', () => {
    expect(defaultPolicy().thresholds).toEqual({
      call: {
        hold_destructive: 0.7,
        hold_exfiltration: 0.6,
        hold_policy: 0.7,
        hold_off_task: 0.9,
      },
      result: {
        annotate_instructs: 0.5,
        quarantine_instructs: 0.8,
        harmful_severity_level: 1.5,
        redact_secret: 0.7,
      },
      uncertain_severity_confidence: 0.5,
    });
  });

  it('starts in shadow, so nothing is blocked before anyone has read their own log', () => {
    expect(defaultPolicy().mode).toBe('shadow');
  });

  it('treats an empty file as the defaults rather than an error', () => {
    expect(parsePolicy('')).toEqual(defaultPolicy());
    expect(parsePolicy('# only a comment\n')).toEqual(defaultPolicy());
  });

  it('keeps the thresholds a file does not mention', () => {
    const policy = parsePolicy('thresholds:\n  call:\n    hold_destructive: 0.42\n');
    expect(policy.thresholds.call.hold_destructive).toBe(0.42);
    expect(policy.thresholds.call.hold_exfiltration).toBe(0.6);
    expect(policy.thresholds.result.quarantine_instructs).toBe(0.8);
  });
});

describe('rejecting a policy that would behave surprisingly', () => {
  const problems = (text: string): readonly string[] => {
    try {
      parsePolicy(text);
    } catch (error) {
      return (error as PolicyError).problems;
    }
    throw new Error('expected the policy to be rejected');
  };

  it('rejects a probability above one, naming the key', () => {
    expect(problems('thresholds:\n  call:\n    hold_destructive: 1.5\n')[0]).toContain(
      'thresholds.call.hold_destructive',
    );
  });

  it('rejects a negative probability', () => {
    expect(problems('thresholds:\n  result:\n    redact_secret: -0.1\n')[0]).toContain(
      'thresholds.result.redact_secret',
    );
  });

  it('accepts a probability at either end of the range', () => {
    const policy = parsePolicy(
      'thresholds:\n  call:\n    hold_destructive: 0\n  result:\n    redact_secret: 1\n',
    );
    expect(policy.thresholds.call.hold_destructive).toBe(0);
    expect(policy.thresholds.result.redact_secret).toBe(1);
  });

  it('rejects a severity level outside the four the question describes', () => {
    expect(problems('thresholds:\n  result:\n    harmful_severity_level: 4\n')[0]).toContain(
      'harmful_severity_level',
    );
  });

  it('rejects an unknown mode and says which ones exist', () => {
    const [first] = problems('mode: paranoid\n');
    expect(first).toContain('mode');
    expect(first).toContain('shadow');
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expect(problems('thresholds:\n  call:\n    hold_destrutive: 0.5\n')[0]).toContain(
      'hold_destrutive',
    );
    expect(problems('unknown_section: 1\n')[0]).toContain('unknown_section');
    expect(problems('servers:\n  github:\n    trust_annotation: true\n')[0]).toContain(
      'trust_annotation',
    );
  });

  it('rejects a threshold that is not a number', () => {
    expect(problems('thresholds:\n  call:\n    hold_policy: "high"\n')[0]).toContain('hold_policy');
  });

  it('reports every problem, not just the first', () => {
    expect(problems('mode: loud\nunknown_section: 1\n').length).toBeGreaterThan(1);
  });

  it('explains unreadable YAML instead of only naming an error class', () => {
    let caught: PolicyError | undefined;
    try {
      parsePolicy('key: [unclosed\n');
    } catch (error) {
      caught = error as PolicyError;
    }
    expect(caught).toBeInstanceOf(PolicyError);
    expect(caught?.message).toContain('not valid YAML');
    expect(caught?.problems).toHaveLength(1);
    expect(caught?.problems[0]?.length).toBeGreaterThan(10);
    expect(caught?.problems[0]).not.toContain('    at ');
  });

  it('rejects an annotate threshold that quarantine would always reach first', () => {
    expect(problems('thresholds:\n  result:\n    annotate_instructs: 0.9\n')[0]).toContain(
      'annotate_instructs',
    );
    expect(() =>
      parsePolicy('thresholds:\n  result:\n    annotate_instructs: 0.8\n'),
    ).not.toThrow();
  });

  it('redacts every known kind unless a file narrows it', () => {
    expect(defaultPolicy().redaction.patterns).toContain('aws_key');
    expect(parsePolicy('redaction:\n  patterns: [aws_key]\n').redaction.patterns).toEqual([
      'aws_key',
    ]);
  });

  it('rejects a redaction kind it has no pattern for', () => {
    expect(problems('redaction:\n  patterns: [not_a_kind]\n')[0]).toContain('patterns');
  });

  it('lets a server be listed with no settings, meaning the defaults', () => {
    const policy = parsePolicy('servers:\n  github:\n');
    expect(policyForServer(policy, 'github').screen_calls).toBe(true);
  });

  it('treats a section written but left empty as the defaults', () => {
    // This is what a file looks like when someone comments out its contents.
    const policy = parsePolicy('thresholds:\nservers:\nredaction:\n');
    expect(policy.thresholds.call.hold_destructive).toBe(0.7);
    expect(policy.servers).toEqual({});
    expect(policy.redaction.patterns.length).toBeGreaterThan(0);
  });

  it('never puts a filesystem path in the message', () => {
    for (const bad of [
      'mode: loud\n',
      'thresholds:\n  call:\n    hold_policy: 9\n',
      'key: [unclosed\n',
    ]) {
      let caught: PolicyError | undefined;
      try {
        parsePolicy(bad);
      } catch (error) {
        caught = error as PolicyError;
      }
      const text = `${caught?.message ?? ''} ${caught?.problems.join(' ') ?? ''}`;
      expect(text).not.toContain('/Users');
      expect(text).not.toContain('/src/');
      expect(text).not.toContain(process.cwd());
    }
  });
});

describe('per-server settings', () => {
  const policy = parsePolicy(`
servers:
  github:
    allow_tools: [get_*, list_*]
  internal-docs:
    screen_results: false
`);

  it('resolves a server that says nothing to the defaults', () => {
    expect(policyForServer(policy, 'filesystem')).toEqual({
      trust_annotations: false,
      allow_tools: [],
      deny_tools: [],
      screen_calls: true,
      screen_results: true,
      screen_tool_list: true,
    });
  });

  it('keeps the defaults for the fields a server does not mention', () => {
    const github = policyForServer(policy, 'github');
    expect(github.allow_tools).toEqual(['get_*', 'list_*']);
    expect(github.screen_calls).toBe(true);
    expect(github.trust_annotations).toBe(false);
  });

  it('honours a server that opts out of result screening', () => {
    expect(policyForServer(policy, 'internal-docs').screen_results).toBe(false);
  });

  it('does not resolve a server name through the prototype chain', () => {
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const resolved = policyForServer(policy, name);
      expect(typeof resolved).toBe('object');
      expect(resolved.screen_calls).toBe(true);
      expect(resolved.screen_results).toBe(true);
    }
  });

  it('does not trust a server advertising its own annotations until told to', () => {
    expect(defaultPolicy().servers['anything']).toBeUndefined();
    expect(policyForServer(defaultPolicy(), 'anything').trust_annotations).toBe(false);
  });
});

function designExample(): string {
  const design = readFileSync(new URL('../../docs/design.md', import.meta.url), 'utf8');
  const section = design.slice(design.indexOf('## 6. Policy file'));
  const start = section.indexOf('```yaml');
  return section.slice(start + '```yaml'.length, section.indexOf('```', start + 1));
}

describe('the example in the design document', () => {
  it('parses, read from the document itself rather than a copy of it', () => {
    const example = designExample();
    expect(example).toContain('mode:');

    const policy = parsePolicy(example);
    expect(policy.mode).toBe('shadow');
    expect(policy.policy).toContain('force-push');
    expect(policy.redaction.patterns.length).toBeGreaterThan(0);
    expect(policyForServer(policy, 'filesystem').deny_tools).toEqual(['delete_file']);
    expect(policyForServer(policy, 'internal-docs').screen_results).toBe(false);
  });

  it('documents every threshold the schema defines, and no others', () => {
    // Compare the raw document against the schema. Comparing the parsed result
    // would prove nothing, because parsing fills in every default.
    const written = parseYaml(designExample()) as {
      thresholds: { call: object; result: object; uncertain_severity_confidence?: number };
    };
    const defaults = defaultPolicy().thresholds;
    expect(Object.keys(written.thresholds.call).sort()).toEqual(Object.keys(defaults.call).sort());
    expect(Object.keys(written.thresholds.result).sort()).toEqual(
      Object.keys(defaults.result).sort(),
    );
    expect(written.thresholds.uncertain_severity_confidence).toBe(
      defaults.uncertain_severity_confidence,
    );
  });
});
