/**
 * agent-chaperone public entry point.
 *
 * Today this exposes the transparent proxy. The screens, the policy engine and
 * the audit log attach to the proxy's event seam as they land. See
 * docs/design.md for the architecture and ROADMAP.md for the order.
 */

export const PACKAGE_NAME = 'agent-chaperone';

export {
  createProxy,
  spawnUpstream,
  inspect,
  RequestCorrelator,
  LineBuffer,
  LineTooLongError,
  UpstreamStartError,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_PENDING,
  DEFAULT_MAX_PENDING_BYTES,
  frame,
} from './proxy/index.js';
export {
  MODES,
  PolicyError,
  assessSeverity,
  decidePostResult,
  decidePreCall,
  defaultPolicy,
  parsePolicy,
  policyForServer,
  policySchema,
  shouldScreen,
} from './policy/index.js';
export type {
  CorrelatorOptions,
  Direction,
  Envelope,
  EnvelopeKind,
  JsonRpcId,
  PendingRequest,
  ProxyEvent,
  ProxyHandle,
  ProxyOptions,
  ProxyStreams,
  Upstream,
} from './proxy/index.js';
export type {
  CallAction,
  CallAnswers,
  CallReason,
  CallRuleFindings,
  CallThresholds,
  Decision,
  Mode,
  Policy,
  ResultAction,
  ResultAnswers,
  ResultRuleFindings,
  ResultThresholds,
  ScoreAnswer,
  ServerPolicy,
  SeverityAssessment,
  SeverityLabel,
} from './policy/index.js';
