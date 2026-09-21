---
'agent-chaperone': patch
---

Redact the credential itself rather than the first thing in the match that looks like it. The span was located by searching the match for the captured text, which finds its first appearance, so a connection string whose password equals its scheme or username had the placeholder written over the scheme and the password left readable. `postgres://postgres:postgres@host` redacted as `[REDACTED:connection_string]://postgres:postgres@host`. The record still reported a secret as found and redacted, so a reader was told the credential had been handled while it sat in the audit log in cleartext, and the same span was what went to the model backend. Default credential pairs are exactly this shape. A field name long enough to equal its own value, `secret_access_key=secret_access_key`, had the same problem.
