/**
 * The screening gate: what the proxy asks before it relays a message.
 *
 * This is where the pieces meet. The deterministic rules run first and can
 * settle a call without a request. What is left becomes a screen, the screen
 * becomes one backend call, and the answers become an action the policy chose.
 * Everything before this is pure; everything about talking to the model and the
 * peers lives here.
 *
 * Two properties are worth stating outright. A message that is not screened
 * returns a verdict rather than a promise, so it is written in the same turn it
 * arrived and pays nothing for the gate existing. And what the policy decided is
 * recorded separately from what was done about it, which is what makes shadow
 * mode a real mode rather than a switch that turns the tool off: it screens
 * everything, records every judgment, and applies nothing.
 */

import { randomBytes } from 'node:crypto';
import type { Backend, BackendFailure, BackendResult, Battery } from '../backends/index.js';
import type {
  CallAction,
  CallAnswers,
  CallRuleFindings,
  Mode,
  Policy,
  ResultAction,
  ResultAnswers,
  ResultRuleFindings,
} from '../policy/index.js';
import { sanitizeMessage } from '../backends/index.js';
import { decidePostResult, decidePreCall, policyForServer, shouldScreen } from '../policy/index.js';
import type { Envelope, Gate, GateVerdict, PendingRequest } from '../proxy/index.js';
import { MAX_MATCHES, inspectResult, inspectToolCall } from '../rules/index.js';
import {
  buildPostResultScreens,
  buildPreCallScreen,
  mergeResultAnswers,
  readCallAnswers,
  readResultAnswers,
} from '../screens/index.js';
import {
  RESOURCE_READ,
  TOOL_CALL,
  readResultText,
  readToolCall,
  toolError,
  withText,
} from './mcp.js';
import {
  annotated,
  blockedCall,
  heldCall,
  partlyUnscreened,
  quarantined,
  withheldSecret,
} from './notices.js';

const FORWARD: GateVerdict = { kind: 'forward' };

/**
 * How many blocks of one result will be screened before the rest is treated as
 * unread. Five times the rules layer's own default, so ordinary results are read
 * whole and only something deliberately enormous reaches the limit.
 */
export const MAX_SCREENED_BLOCKS = 1000;

/**
 * A backend that throws where the interface says it returns.
 *
 * The relay's own fallback is to forward, which is right for a relay and wrong
 * for a firewall: it would let a bug in screening quietly undo what `strict`
 * promises. So an unexpected throw is turned into the same failure the modes
 * already know how to handle, and the decision stays with the policy.
 */
async function ask<B extends Battery>(
  run: () => Promise<BackendResult<B>>,
): Promise<BackendResult<B>> {
  try {
    return await run();
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'unknown',
        retryable: false,
        message: 'the backend raised instead of answering',
      },
    };
  }
}

/** What the model cost and how long it took, for the one line the audit log keeps. */
export interface BackendUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly latencyMs: number;
  readonly requests: number;
}

export interface CallJudgment {
  readonly side: 'call';
  /** False when no model was asked, so a forward is not mistaken for an all-clear. */
  readonly screened: boolean;
  readonly tool: string;
  readonly server: string;
  readonly mode: Mode;
  readonly intended: CallAction;
  readonly applied: CallAction;
  readonly answers: CallAnswers;
  readonly rules: CallRuleFindings;
  readonly secrets: readonly string[];
  /** The arguments as they went to the model, which is to say already redacted. */
  readonly arguments: unknown;
  readonly usage?: BackendUsage;
  readonly failure?: BackendFailure;
  readonly id: string;
}

export interface ResultJudgment {
  readonly side: 'result';
  /** False when no model was asked, so a forward is not mistaken for an all-clear. */
  readonly screened: boolean;
  readonly tool: string;
  readonly server: string;
  readonly mode: Mode;
  readonly intended: ResultAction;
  readonly applied: ResultAction;
  readonly answers: ResultAnswers;
  readonly rules: ResultRuleFindings;
  readonly secrets: readonly string[];
  readonly blocks: number;
  /**
   * What never reached the screen: blocks past the cap, characters in them, and
   * parts that were not text. `screened` alone would otherwise claim the whole
   * result was read when part of it was not.
   */
  readonly unscreened: {
    readonly blocks: number;
    readonly chars: number;
    readonly parts: number;
  };
  /** Concealment found anywhere in the result, including in text no block holds. */
  readonly hidden: readonly string[];
  /** The result text as it went to the model, which is to say already redacted. */
  readonly text: string;
  readonly usage?: BackendUsage;
  readonly failure?: BackendFailure;
  readonly id: string;
}

export type Judgment = CallJudgment | ResultJudgment;

export interface ScreeningOptions {
  readonly policy: Policy;
  /** Which server this proxy fronts, for the per-server section of the policy. */
  readonly server: string;
  /**
   * Without one, the deterministic rules are the whole screen. That is what the
   * tool does when no API key is configured: allow and deny lists still apply,
   * and every judgment says plainly that no model was asked.
   */
  readonly backend?: Backend;
  /** What the user asked for, when something recorded it. Enables the off-task question. */
  readonly task?: string;
  /** Every judgment, decided or not applied. The audit log is the first consumer. */
  readonly onJudgment?: (judgment: Judgment) => void;
  /** Ids for held calls and withheld results, so a user can name one on the command line. */
  readonly newId?: () => string;
}

/**
 * Short enough to retype off a terminal, and unique across processes.
 *
 * A counter would collide between the several servers a client wraps at once,
 * and `show` searches every session for the id it was given, so two decisions
 * sharing one would hand the user whichever was found first.
 */
function defaultId(): string {
  return randomBytes(5).toString('hex');
}

/**
 * How a backend that could not answer is handled, from ADR-0002.
 *
 * An agent session that stalls because a screening request failed is worse than
 * one that ran unscreened for a message, so only `strict` stops. `enforce` holds
 * the calls the deterministic layer already had doubts about, which is the part
 * that costs nothing and does not depend on the model being reachable.
 */
function onCallFailure(mode: Mode, rules: CallRuleFindings, dangerous: boolean): CallAction {
  // The reason is that nothing was judged, not that anything was judged
  // destructive. Saying otherwise would have the tool report a finding it never
  // made, to the agent and to whoever reads the log.
  if (mode === 'strict') {
    return { kind: 'hold', reason: 'not-screened', probability: 0 };
  }
  if (mode === 'enforce' && dangerous) {
    return { kind: 'hold', reason: 'not-screened', probability: 0 };
  }
  return rules.denied_by === undefined && rules.outside_allow_list !== true
    ? { kind: 'forward' }
    : { kind: 'block', reason: rules.denied_by === undefined ? 'outside-allow-list' : 'deny-list' };
}

function onResultFailure(mode: Mode): ResultAction {
  return mode === 'strict'
    ? { kind: 'quarantine', probability: 0, severity: { label: 'high', score: 2, uncertain: true } }
    : { kind: 'pass' };
}

const UNSURE: ResultAction = {
  kind: 'quarantine',
  probability: 0,
  severity: { label: 'high', score: 2, uncertain: true },
};

/**
 * Text the screen did not read because there was too much of it.
 *
 * Whoever wrote the result decides how many paragraphs it has, so this is a
 * lever an attacker holds: pad past the cap and the tail is never put in front
 * of a model. A result with an unread tail is therefore withheld rather than
 * annotated, because nothing here can say what is in the part nobody read.
 */
function onTruncated(mode: Mode): ResultAction {
  return mode === 'shadow' ? { kind: 'pass' } : UNSURE;
}

/**
 * Parts that are not text at all, such as an image or a base64 blob.
 *
 * Different from a tail that was cut: these cannot be read by anything here, and
 * they are ordinary in honest traffic. Withholding every result that carries a
 * screenshot would make the tool unusable, so enforce says so and passes the
 * content on, and only strict refuses it.
 */
function onUnreadable(mode: Mode): ResultAction {
  if (mode === 'strict') {
    return UNSURE;
  }
  return mode === 'enforce' ? { kind: 'annotate', probability: 0 } : { kind: 'pass' };
}

/** Least to most restrictive, so two independent reasons to act resolve to the stronger one. */
const RESULT_RANK: Record<ResultAction['kind'], number> = {
  pass: 0,
  annotate: 1,
  redact: 2,
  quarantine: 3,
};

function stronger(one: ResultAction, two: ResultAction): ResultAction {
  return RESULT_RANK[two.kind] > RESULT_RANK[one.kind] ? two : one;
}

export function createScreeningGate(options: ScreeningOptions): Gate {
  const { policy, server, backend } = options;
  const report = options.onJudgment ?? ((): void => undefined);
  const newId = options.newId ?? defaultId;
  const server_policy = policyForServer(policy, server);
  const redaction = policy.redaction.patterns;

  const screenCall = async (envelope: Envelope): Promise<GateVerdict> => {
    const call = readToolCall(envelope);
    if (call === undefined || envelope.id === undefined) {
      return FORWARD;
    }

    const rules = inspectToolCall({
      tool: call.name,
      arguments: call.arguments,
      server: server_policy,
      redaction,
    });
    const findings: CallRuleFindings = {
      ...(rules.denied_by === undefined ? {} : { denied_by: rules.denied_by }),
      ...(rules.outside_allow_list === true ? { outside_allow_list: true } : {}),
    };
    const settled = findings.denied_by !== undefined || findings.outside_allow_list === true;

    let answers: CallAnswers = {};
    let usage: BackendUsage | undefined;
    let failure: BackendFailure | undefined;
    let screened = false;

    if (!settled && backend !== undefined) {
      const screen = buildPreCallScreen({
        tool: { name: call.name },
        redacted_arguments: rules.redacted_arguments,
        ...(policy.policy === undefined ? {} : { policy: policy.policy }),
        ...(options.task === undefined ? {} : { task: options.task }),
      });
      const asked = await ask(() => backend.ask(screen.state, screen.battery));
      if (asked.ok) {
        // Answered, not merely attempted. A screen that failed must not read as
        // a decision a model took part in.
        screened = true;
        answers = readCallAnswers(asked.answers);
        usage = {
          model: asked.model,
          inputTokens: asked.inputTokens,
          latencyMs: asked.latencyMs,
          requests: 1,
        };
      } else {
        failure = asked.failure;
      }
    }

    const decision =
      failure === undefined
        ? decidePreCall(answers, findings, policy)
        : {
            intended: onCallFailure(policy.mode, findings, rules.dangerous.length > 0),
            applied:
              policy.mode === 'shadow'
                ? ({ kind: 'forward' } as CallAction)
                : onCallFailure(policy.mode, findings, rules.dangerous.length > 0),
          };

    const id = newId();
    report({
      side: 'call',
      screened,
      // The name came off the wire. It reaches the audit log and from there a
      // terminal, so a server cannot use it to forge a line or move a cursor.
      tool: sanitizeMessage(call.name),
      server,
      mode: policy.mode,
      intended: decision.intended,
      applied: decision.applied,
      answers,
      rules: findings,
      secrets: rules.secrets,
      arguments: rules.redacted_arguments,
      ...(usage === undefined ? {} : { usage }),
      ...(failure === undefined ? {} : { failure }),
      id,
    });

    const action = decision.applied;
    if (action.kind === 'forward') {
      return FORWARD;
    }
    const text =
      action.kind === 'block'
        ? blockedCall(call.name, action.reason, action.detail)
        : heldCall(call.name, action.reason, id, action.severity);
    return { kind: 'answer', raw: toolError(envelope.id, text) };
  };

  const screenResult = async (
    envelope: Envelope,
    request: PendingRequest | undefined,
  ): Promise<GateVerdict> => {
    // A response nobody can pair with a request is screened as a result anyway.
    // The correlator is bounded, and a peer that can force an eviction could
    // otherwise walk a payload straight past the screen by spending requests.
    const method = request?.method ?? TOOL_CALL;
    const body = readResultText(envelope, method);
    if (body === undefined) {
      return FORWARD;
    }

    const call = request === undefined ? undefined : readToolCall(request.envelope);
    const tool = call?.name ?? request?.method ?? 'unknown';
    const inspection = inspectResult({
      text: body.text,
      redaction,
      // Higher than the rules layer's own default, because here the cap decides
      // how much of a result gets screened at all, and chunking already keeps
      // any single request small. It still has to be a cap: without one, a
      // large enough result is an unbounded number of paid requests.
      maxBlocks: MAX_SCREENED_BLOCKS,
    });
    const findings: ResultRuleFindings =
      inspection.hidden_regions === undefined ? {} : { hidden_regions: inspection.hidden_regions };

    const screens = buildPostResultScreens({
      tool: { name: tool },
      blocks: inspection.blocks,
      ...(inspection.hidden_regions === undefined
        ? {}
        : { hidden_regions: inspection.hidden_regions }),
    });

    let answers: ResultAnswers = {};
    let usage: BackendUsage | undefined;
    let failure: BackendFailure | undefined;
    let screened = false;

    if (screens.length > 0 && backend !== undefined) {
      const model = backend;
      // Chunks of one result are independent questions about the same text, so
      // they go out together rather than one after another.
      const asked = await Promise.all(
        screens.map((screen) => ask(() => model.ask(screen.state, screen.battery))),
      );
      const answered = asked.filter((one) => one.ok);
      const firstFailure = asked.find((one) => !one.ok);
      if (firstFailure !== undefined && !firstFailure.ok) {
        failure = firstFailure.failure;
      }
      if (answered.length > 0) {
        screened = true;
        answers = mergeResultAnswers(
          answered.map((one) => (one.ok ? readResultAnswers(one.answers) : {})),
        );
        usage = {
          model: answered[0]?.ok === true ? answered[0].model : 'unknown',
          inputTokens: answered.reduce((sum, one) => sum + (one.ok ? one.inputTokens : 0), 0),
          latencyMs: Math.max(...answered.map((one) => (one.ok ? one.latencyMs : 0))),
          requests: answered.length,
        };
      }
    }

    // What the answers say, and what not having read all of it says. Both are
    // real, so the stronger one wins rather than the later one. A chunk that
    // failed does not throw away what the chunks that answered found: those
    // answers still decide, and the failure raises the floor.
    const decided = decidePostResult(answers, findings, policy);
    const truncated = inspection.dropped_blocks > 0;
    const unreadable = body.unreadable > 0 || (screens.length === 0 && body.text === '');
    const incomplete = truncated || unreadable || failure !== undefined || !screened;

    let floor: ResultAction = { kind: 'pass' };
    if (truncated) {
      floor = stronger(floor, onTruncated(policy.mode));
    }
    if (unreadable) {
      floor = stronger(floor, onUnreadable(policy.mode));
    }
    if (failure !== undefined) {
      floor = stronger(floor, onResultFailure(policy.mode));
    }

    // Rules-only is a configuration rather than a gap: with no backend the
    // deterministic layer is the whole screen, and a judgment that says
    // `screened: false` has already said so without withholding anything.
    const intended = backend === undefined ? decided.intended : stronger(decided.intended, floor);
    const applied = policy.mode === 'shadow' ? ({ kind: 'pass' } as ResultAction) : intended;

    const id = newId();
    report({
      side: 'result',
      screened,
      tool: sanitizeMessage(tool),
      server,
      mode: policy.mode,
      intended,
      applied,
      answers,
      rules: findings,
      secrets: inspection.secrets,
      blocks: inspection.blocks.length,
      unscreened: {
        blocks: inspection.dropped_blocks,
        chars: inspection.dropped_chars,
        parts: body.unreadable,
      },
      hidden: inspection.hidden_kinds,
      // At the cap the redaction stopped looking, so later secret shapes are
      // still in the text. The audit log must not hold a credential the request
      // did not carry, and nothing here can say which ones survived.
      text:
        inspection.secrets.length >= MAX_MATCHES
          ? '[content not stored: too many secret shapes to redact them all]'
          : inspection.redacted_text,
      ...(usage === undefined ? {} : { usage }),
      ...(failure === undefined ? {} : { failure }),
      id,
    });

    if (applied.kind === 'pass') {
      return FORWARD;
    }
    const replacement =
      applied.kind === 'quarantine'
        ? quarantined(tool, applied.block, id)
        : applied.kind === 'redact'
          ? // The regexes already ran before the model was asked, so replacing
            // the body with their output would change nothing in exactly the
            // case this action exists for: a shape they did not match. Nothing
            // in the battery says where it is, so none of it goes out.
            withheldSecret(tool, id)
          : incomplete && applied.probability === 0
            ? partlyUnscreened(tool, inspection.redacted_text)
            : annotated(inspection.blocks, applied.block);
    const raw = withText(envelope, body.shape, replacement);
    return raw === undefined ? FORWARD : { kind: 'replace', raw };
  };

  /**
   * What happens when screening itself raises.
   *
   * The relay's own fallback is to forward, which is right for a relay and wrong
   * for a firewall: it would let a bug here quietly undo what `strict` promises.
   * So a throw is handled the way an unreachable backend is, by the mode.
   */
  const onCallBug = (envelope: Envelope): GateVerdict => {
    const action = onCallFailure(policy.mode, {}, false);
    if (policy.mode === 'shadow' || action.kind === 'forward' || envelope.id === undefined) {
      return FORWARD;
    }
    const id = newId();
    const text =
      action.kind === 'block'
        ? blockedCall('unknown', action.reason, action.detail)
        : heldCall('unknown', action.reason, id, action.severity);
    return { kind: 'answer', raw: toolError(envelope.id, text) };
  };

  const onResultBug = (envelope: Envelope, method: string): GateVerdict => {
    const action = onResultFailure(policy.mode);
    if (policy.mode === 'shadow' || action.kind === 'pass') {
      return FORWARD;
    }
    const shape = method === RESOURCE_READ ? 'resource' : 'tool';
    const raw = withText(envelope, shape, quarantined('unknown', undefined, newId()));
    return raw === undefined ? FORWARD : { kind: 'replace', raw };
  };

  return (envelope, direction, request) => {
    if (direction === 'client-to-upstream') {
      if (
        envelope.kind !== 'request' ||
        envelope.method !== TOOL_CALL ||
        !shouldScreen(policy, server, 'calls')
      ) {
        return FORWARD;
      }
      return screenCall(envelope).catch(() => onCallBug(envelope));
    }

    if (envelope.kind !== 'response' || !shouldScreen(policy, server, 'results')) {
      return FORWARD;
    }
    // An uncorrelated response is screened rather than waved through: the
    // correlator is bounded, and a peer able to force an eviction could
    // otherwise spend requests to walk a payload past the screen. A response
    // carrying nothing readable still costs nothing, because there is no text
    // to send.
    if (request !== undefined && request.method !== TOOL_CALL && request.method !== RESOURCE_READ) {
      return FORWARD;
    }
    return screenResult(envelope, request).catch(() =>
      onResultBug(envelope, request?.method ?? TOOL_CALL),
    );
  };
}
