/**
 * The policy file: its shape, its defaults, and how a bad one is reported.
 *
 * Field names match the YAML exactly rather than being converted to camel case.
 * One vocabulary means a validation message, a replayed decision and the file a
 * user is editing all call the same thing by the same name.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Every threshold in the system is a number in this file and nowhere else. */
const probability = z.number().min(0).max(1);

/** Severity is a position on the four described levels, not a probability. */
const severityLevel = z.number().min(0).max(3);

export const MODES = ['shadow', 'enforce', 'strict'] as const;
export type Mode = (typeof MODES)[number];

const callThresholds = z.strictObject({
  hold_destructive: probability.default(0.7),
  hold_exfiltration: probability.default(0.6),
  hold_policy: probability.default(0.7),
  hold_off_task: probability.default(0.9),
});

const resultThresholds = z
  .strictObject({
    annotate_instructs: probability.default(0.5),
    quarantine_instructs: probability.default(0.8),
    harmful_severity_level: severityLevel.default(1.5),
    redact_secret: probability.default(0.7),
  })
  // Quarantine is checked first, so an annotate threshold above it can never be
  // reached. Silently dead configuration is worse than a rejected file.
  .refine((t) => t.annotate_instructs <= t.quarantine_instructs, {
    error:
      'annotate_instructs must not be above quarantine_instructs, or it could never be reached',
    path: ['annotate_instructs'],
  });

const serverPolicy = z.strictObject({
  /**
   * MCP says a client must treat a server's own tool annotations as untrusted
   * unless the server is trusted, so this stays off until a user says otherwise.
   */
  trust_annotations: z.boolean().default(false),
  /** Empty means no allow list, so every tool is permitted unless denied. */
  allow_tools: z.array(z.string()).default([]),
  deny_tools: z.array(z.string()).default([]),
  screen_calls: z.boolean().default(true),
  screen_results: z.boolean().default(true),
});

/** A section written but left empty, as happens when its contents are commented out, means the defaults. */
function section<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => value ?? undefined, schema);
}

export const policySchema = z.strictObject({
  mode: z.enum(MODES).default('shadow'),
  /** The plain-English statement the policy_violation question is asked against. */
  policy: z.string().optional(),
  thresholds: section(
    z
      .strictObject({
        call: callThresholds.prefault({}),
        result: resultThresholds.prefault({}),
        /**
         * Below this confidence, a severity answer labels its action uncertain
         * rather than stating it flatly, so the text a user sees reads as the
         * tool asking. It governs both screens, which is why it sits beside them
         * rather than inside either one.
         */
        uncertain_severity_confidence: probability.default(0.5),
      })
      .prefault({}),
  ),
  servers: section(z.record(z.string(), serverPolicy).default({})),
  redaction: section(
    z
      .strictObject({
        patterns: z.array(z.string()).default([]),
      })
      .prefault({}),
  ),
});

export type Policy = z.infer<typeof policySchema>;
export type ServerPolicy = z.infer<typeof serverPolicy>;
export type CallThresholds = Policy['thresholds']['call'];
export type ResultThresholds = Policy['thresholds']['result'];

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** The policy in force when there is no file at all. */
export function defaultPolicy(): Policy {
  return policySchema.parse({});
}

/**
 * Parse policy text.
 *
 * Errors name the offending key and what was expected, and never carry a
 * filesystem path: a caller that knows which file this came from can say so,
 * and a message that reaches an agent should not describe the disk.
 */
export function parsePolicy(text: string): Policy {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? firstLine(error.message) : 'could not be read';
    throw new PolicyError(`The policy is not valid YAML: ${detail}`, [detail]);
  }

  if (document === null || document === undefined) {
    return defaultPolicy();
  }

  const result = policySchema.safeParse(document);
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues.map(describe);
  throw new PolicyError(
    `The policy has ${problems.length === 1 ? 'a problem' : 'problems'}.`,
    problems,
  );
}

/**
 * The policy in force for one server: its own settings where it has them, the
 * defaults everywhere else.
 */
export function policyForServer(policy: Policy, server: string): ServerPolicy {
  // An own-property check, because a server named after something on
  // Object.prototype would otherwise resolve to an inherited member and turn
  // screening off without anyone writing that down.
  return Object.hasOwn(policy.servers, server)
    ? (policy.servers[server] ?? serverPolicy.parse({}))
    : serverPolicy.parse({});
}

function describe(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${where}: ${issue.message}`;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}
