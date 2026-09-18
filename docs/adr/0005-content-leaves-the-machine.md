# ADR-0005: Screened Content Leaves the Machine, With Controls

## Status

Accepted

## Context

The judgments come from a hosted model. Screening a tool result means sending that result to the backend. Some content must never leave the machine, and some users will refuse the trade entirely.

## Decision

- The README states on its first screen that screened arguments and results are sent to the configured backend.
- Secret-shaped strings are redacted before anything is sent and before anything is logged. Redaction also helps the judgment, since the model is asked whether a secret is present, not what it is.
- Per-server `screen_results: false` and `screen_calls: false` keep a server's content local.
- Results above a configurable size are screened by their first and last chunks, and the log records the skip.
- Without a key the proxy runs rules-only and says so once at startup.
- The design links to the backend's data handling terms rather than paraphrasing them.

## Consequences

- Users can see exactly what leaves and turn it off per server.
- Rules-only mode is weak and is described as such.
- Any future backend that runs locally can be added behind the same interface without changing the screens.
