/**
 * The pre-call screen: a tool call turned into one request, and the answers
 * turned back into what the decision rules read.
 *
 * The state carries only what is known. With a tool and arguments and nothing
 * else, the request is field for field what the benchmark measured, which is
 * what lets the README's numbers describe the tool as it actually ships. A
 * policy, a task or tool annotations are additions to that request, and the
 * questions they belong to are added with them rather than asked into a blank.
 *
 * Arguments arrive redacted. The rules layer has already replaced every secret
 * shape it matched, and the field is named for that here so passing the
 * original is a visible mistake rather than a quiet one.
 */

import type { Answer, Battery } from '../backends/index.js';
import type { CallAnswers, ScoreAnswer } from '../policy/index.js';
import {
  DESTRUCTIVE,
  EXFILTRATION,
  CALL_SEVERITY,
  OFF_TASK,
  POLICY_VIOLATION,
  SECRET_IN_ARGS,
} from './questions.js';

export interface PreCallTool {
  readonly name: string;
  readonly description?: string;
  /**
   * The server's own hints. The MCP spec says a client must treat these as
   * untrusted unless it trusts the server, so they are shown to the model as
   * part of what the server claims, never used to skip a question.
   */
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface PreCallState {
  readonly tool: PreCallTool;
  readonly arguments: unknown;
  readonly policy?: string;
  readonly task?: string;
}

export interface PreCallInput {
  readonly tool: PreCallTool;
  /** From `inspectToolCall`. Never the arguments as they arrived. */
  readonly redacted_arguments: unknown;
  /** The plain-English policy, when the user wrote one. */
  readonly policy?: string;
  /** What the user asked for, when something recorded it. */
  readonly task?: string;
}

export interface PreCallScreen {
  readonly state: PreCallState;
  readonly battery: Battery;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * The request for one tool call.
 *
 * Key order is deliberate and is asserted by the golden tests: the state is
 * built in the order the design document writes it, and the battery leads with
 * the three measured questions in the order the harness sent them, so what the
 * measurement covers stays visible in the request itself.
 */
export function buildPreCallScreen(input: PreCallInput): PreCallScreen {
  const tool: PreCallTool = {
    name: input.tool.name,
    ...(present(input.tool.description) ? { description: input.tool.description } : {}),
    ...(input.tool.annotations !== undefined && Object.keys(input.tool.annotations).length > 0
      ? { annotations: input.tool.annotations }
      : {}),
  };

  const state: PreCallState = {
    tool,
    arguments: input.redacted_arguments,
    ...(present(input.policy) ? { policy: input.policy } : {}),
    ...(present(input.task) ? { task: input.task } : {}),
  };

  const battery: Battery = {
    destructive: DESTRUCTIVE,
    exfiltration: EXFILTRATION,
    severity: CALL_SEVERITY,
    secret_in_args: SECRET_IN_ARGS,
    ...(present(input.policy) ? { policy_violation: POLICY_VIOLATION } : {}),
    ...(present(input.task) ? { off_task: OFF_TASK } : {}),
  };

  return { state, battery };
}

export function noulOf(answers: Readonly<Record<string, Answer>>, id: string): number | undefined {
  const answer = answers[id];
  return answer?.kind === 'noul' ? answer.noul : undefined;
}

export function scoreOf(
  answers: Readonly<Record<string, Answer>>,
  id: string,
): ScoreAnswer | undefined {
  const answer = answers[id];
  return answer?.kind === 'score'
    ? { score: answer.score, confidence: answer.confidence }
    : undefined;
}

/**
 * The answers in the shape the decision rules read.
 *
 * A question that was not asked stays absent rather than becoming a zero. The
 * rules treat an absent answer as skipped, and a zero would read as the model
 * having considered it and said no.
 */
export function readCallAnswers(answers: Readonly<Record<string, Answer>>): CallAnswers {
  const destructive = noulOf(answers, 'destructive');
  const exfiltration = noulOf(answers, 'exfiltration');
  const secret_in_args = noulOf(answers, 'secret_in_args');
  const policy_violation = noulOf(answers, 'policy_violation');
  const off_task = noulOf(answers, 'off_task');
  const severity = scoreOf(answers, 'severity');

  return {
    ...(destructive === undefined ? {} : { destructive }),
    ...(exfiltration === undefined ? {} : { exfiltration }),
    ...(secret_in_args === undefined ? {} : { secret_in_args }),
    ...(policy_violation === undefined ? {} : { policy_violation }),
    ...(off_task === undefined ? {} : { off_task }),
    ...(severity === undefined ? {} : { severity }),
  };
}
