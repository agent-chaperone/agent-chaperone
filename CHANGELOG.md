# agent-chaperone

## 0.3.3

### Patch Changes

- 8caf7dd: `wrap` says what to do with a Gemini CLI server written as `httpUrl`, Gemini CLI's deprecated spelling of a Streamable HTTP server. It was skipped with the reason `it names no command or http url`, which read as if the entry had no URL. It is still skipped, because `--unwrap` could not give back an `httpUrl` it never recorded, and the reason now says to change it to `url` with `"type": "http"`, as Gemini CLI recommends, and run `wrap` again.

## 0.3.2

### Patch Changes

- 4381666: `wrap` no longer writes a remote entry the client cannot start. A server declared as `{"type": "http", "url": ...}`, which is how VS Code writes one, was rewritten to run the proxy but kept `type: "http"`, so the client looked for a URL the entry no longer had. It now says `stdio`, and `--unwrap` puts `http` back. An entry declaring any other transport, such as legacy SSE, which the proxy cannot reach, is skipped with the reason instead of being rewritten. So is an entry carrying `headers`, `oauth`, `auth` or `authProviderType`, which would otherwise have kept its credentials in the file while nothing sent them, so the server refused every call. `--header-env` passes a token to the proxy instead.

## 0.3.1

### Patch Changes

- cc81536: Redact the credential itself rather than the first thing in the match that looks like it. The span was located by searching the match for the captured text, which finds its first appearance, so a connection string whose password equals its scheme or username had the placeholder written over the scheme and the password left readable. `postgres://postgres:postgres@host` redacted as `[REDACTED:connection_string]://postgres:postgres@host`. The record still reported a secret as found and redacted, so a reader was told the credential had been handled while it sat in the audit log in cleartext, and the same span was what went to the model backend. Default credential pairs are exactly this shape. A field name long enough to equal its own value, `secret_access_key=secret_access_key`, had the same problem.

## 0.3.0

### Minor Changes

- Screen through OpenRouter or the Vercel AI Gateway when TypeSafe is not available. Their probabilities are not calibrated: every threshold that ships was chosen against measured numbers from a different model, so the published results say nothing about these. The proxy names the backend it is using and says so every session.
- Record what the tool-list screen decided, so `log` and `show` can read it. A description judged to be steering the agent was written once to stderr and was then gone, which is the wrong shape for the finding most likely to arrive when nobody is looking. It is its own record kind rather than a judgment, since there is no call, no arguments and no action: the list is always relayed.
- `agent-chaperone report` says what the log adds up to, leading with how many decisions would have been stopped had enforcement been on. `agent-chaperone replay` decides again over what was already judged, under another policy, and says which way each one moved. Choosing a threshold by reasoning about it is guesswork; the log holds the probabilities every past decision came from.
- Read tool descriptions as untrusted text, behind `screen_tool_descriptions`, which is off by default because turning it on sends every new or changed description to the model backend. It asks whether a description goes beyond describing its own tool and tries to steer the assistant. That question is not covered by the published numbers, the threshold is a judgement rather than a figure off a curve, and the notice says so. What is recorded is a digest of what a server advertised first and a cache of judgments keyed by name and digest, kept apart so a tampered description is reported on every connection rather than becoming the expectation after one.
- `agent-chaperone task` records what the agent was asked to do, scoped to the working directory. The off-task question needs something no tool call contains and nothing ever supplied one, so it has never been sent. A task is believed for twelve hours, because a stale one would have the screen judging today's calls against intent the user has moved on from.
- `agent-chaperone wrap` puts a client's MCP servers behind the screen, and `--unwrap` takes them back out. It prints what it would change and writes nothing until asked with `--write`, keeping the original beside the file. Idempotent in both directions, and it names the policy section after the key already in the client's file.

### Patch Changes

- Assemble a paginated tool list before comparing it. A server that answers `tools/list` in pages was compared against a slice of itself, which reported every page but the last as removed, on every connection, for as long as it kept paginating. Pages are now collected and nothing is compared until the listing ends. A listing that runs past sixty-four pages or four thousand tools is abandoned and reported as unchecked rather than held for the life of the session.
- Answer a repeated question without asking again. An agent rereading one file builds the same state and the same battery every time, which is the same request, and every one was sent. Failures are not cached, since a failure is about the moment rather than the question, and a cached answer reports that it cost nothing so the log does not add up a bill for requests nobody made.

## 0.2.0

### Minor Changes

- a205d59: Notice when a server changes the tools it advertises. The first tool list a server sends is recorded as a digest of each tool's description and input schema, and every later list is compared against it, so a rewritten description, a new tool or a removed one is reported. The comparison is local and sends nothing anywhere, and it never withholds the list, because a client that cannot read the tool list cannot call anything. `agent-chaperone trust <server>` accepts a change. `screen_tool_list` turns it off per server, separately from the screens that talk to a model.
- a205d59: Screen a Streamable HTTP upstream the same way as a stdio one. A URL in place of a command wraps the server at that URL, with the same policy file, thresholds, audit log and hold flow a local server gets, because the HTTP transport presents itself to the relay as the same pair of streams a child process would. `--header` sends a request header and `--header-env` reads its value from the environment, so a token stays out of the process list. A URL with no `--server` answers to its host in the policy file.

### Patch Changes

- a205d59: Act on a deterministic finding when no model was asked. A call that the rules layer flagged as a destructive shell form was held in enforce mode if a screening request had failed, but forwarded if no backend was configured at all, which made running with no key less protective than running with a key that does not work. Both cases now take the same path. A denied call is also reported as the deny list catching it, keeping the name of the pattern that matched, rather than as merely unscreened.

## 0.1.0

### Minor Changes

- First published release. Screens an AI agent's tool calls before they run and the tool results those calls return before the agent reads them, over MCP through a transparent proxy and over a client's own shell, file edits and web fetches through a hooks adapter. Deterministic rules and a battery of calibrated judgments decide together, every threshold lives in a policy file, and every decision is written to a local log with the probabilities behind it. Starts in shadow mode, which blocks nothing.
