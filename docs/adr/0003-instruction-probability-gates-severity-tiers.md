# ADR-0003: The Instruction Probability Gates, Severity Selects the Tier

## Status

Accepted

## Context

The first draft of the post-result screen quarantined a result only when two conditions held: the "instructs the reader" probability above a threshold and the severity score above the harmful level. It also asked a second yes/no question, whether the content demanded an action.

The benchmark (see ADR-0004) showed both choices were wrong:

- Gating on severity as well as instruction dropped recall on the email benchmark to 4 percent, because most of its attacks are low-harm (translate this, write a joke) and only 8 percent reach the harmful level. On tool responses carrying data-theft and account-takeover instructions, 84 percent reach it.
- The "demands action" question reached AUC 0.855 on its own against 0.972 for the instruction question, and taking the max of the two lowered the result to 0.888.

## Decision

- The instruction probability alone decides whether a result is acted on.
- Severity decides which action: quarantine at or above the harmful level, annotate below it.
- The "demands action" question is removed from the battery.
- The same shape applies to the pre-call screen: `destructive` and `exfiltration` gate, and severity labels the hold.

## Consequences

- Fewer tokens per request.
- Thresholds are one-dimensional per screen and easier to tune from the log.
- Wording changes to any battery question are re-measured against the benchmark before they ship, because the numbers above came from the exact wording in `docs/design.md`.
