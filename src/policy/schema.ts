/**
 * The policy file: its shape, its defaults, and how a bad one is reported.
 *
 * Field names match the YAML exactly rather than being converted to camel case.
 * One vocabulary means a validation message, a replayed decision and the file a
 * user is editing all call the same thing by the same name.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SECRET_KINDS } from '../rules/secrets.js';

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

/**
 * Unmeasured, unlike the two above. No benchmark covers the tool-list question,
 * so this default is a judgement and not a number read off a curve. It is set
 * where a description has to be doing something fairly overt to reach it,
 * because the cost of a false positive here is a warning about a server that is
 * fine, and a warning nobody trusts is worse than no warning.
 */
const toolListThresholds = z.strictObject({
  report_steers: probability.default(0.7),
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
  /**
   * Compare the tools a server advertises against the ones it first advertised.
   * Separate from the two above because it costs nothing and sends nothing: the
   * comparison is a local digest, so turning off the screens that talk to a
   * model is not a reason to stop noticing that a server changed shape.
   */
  screen_tool_list: z.boolean().default(true),
  /**
   * Ask the model whether a tool's description is steering the agent rather than
   * describing its tool. Off by default, and a switch of its own rather than
   * part of `screen_tool_list`, because it is the one thing in the tool-list
   * path that sends anything anywhere: turning it on sends every new or changed
   * description to the backend. Nobody should acquire that by upgrading.
   */
  screen_tool_descriptions: z.boolean().default(false),
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
        tool_list: toolListThresholds.prefault({}),
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
  // The inner section() lets a server be listed with no settings at all, which
  // means the defaults for it rather than an error.
  servers: section(z.record(z.string(), section(serverPolicy.prefault({}))).default({})),
  redaction: section(
    z
      .strictObject({
        // Everything, unless a file narrows it. An empty default would mean a
        // tool that redacts nothing until someone remembers to ask.
        patterns: z.array(z.enum(SECRET_KINDS)).default([...SECRET_KINDS]),
      })
      .prefault({}),
  ),
});

export type Policy = z.infer<typeof policySchema>;
export type ServerPolicy = z.infer<typeof serverPolicy>;
export type CallThresholds = Policy['thresholds']['call'];
export type ResultThresholds = Policy['thresholds']['result'];
export type ToolListThresholds = Policy['thresholds']['tool_list'];

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
