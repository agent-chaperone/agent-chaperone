---
'agent-chaperone': patch
---

`wrap` no longer writes a remote entry the client cannot start. A server declared as `{"type": "http", "url": ...}`, which is how VS Code writes one, was rewritten to run the proxy but kept `type: "http"`, so the client looked for a URL the entry no longer had. It now says `stdio`, and `--unwrap` puts `http` back. An entry declaring any other transport, such as legacy SSE, which the proxy cannot reach, is skipped with the reason instead of being rewritten. So is an entry carrying `headers`, `oauth`, `auth` or `authProviderType`, which would otherwise have kept its credentials in the file while nothing sent them, so the server refused every call. `--header-env` passes a token to the proxy instead.
