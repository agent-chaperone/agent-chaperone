# ADR-0002: Shadow Mode by Default, Fail-Open Unless Strict

## Status

Accepted

## Context

A firewall that holds a legitimate call twice a day gets uninstalled. The right thresholds depend on the user's traffic, which nobody has seen before installation. The backend is a network service that can time out or rate limit, and an agent session that stalls because a screening request failed is worse than one that ran unscreened for one message.

## Decision

- `shadow` is the default mode. Every message is screened and every judgment is logged with its probabilities, and nothing is blocked. Users move to `enforce` after reading their own log and, if they want, replaying a policy against it.
- In `shadow`, backend failures log and pass through.
- In `enforce`, backend failures pass reads through and hold calls that the deterministic rules or MCP annotations mark as destructive.
- `strict` fails closed on any backend failure.
- The mode is an explicit field in the policy file.

## Consequences

- First-run experience is observation, not interruption.
- Default thresholds can be chosen from measured distributions on real traffic rather than guessed.
- A user who wants fail-closed behavior opts in and knows they did.
