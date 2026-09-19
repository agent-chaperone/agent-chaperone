# agent-chaperone

## 0.2.0

### Minor Changes

- a205d59: Notice when a server changes the tools it advertises. The first tool list a server sends is recorded as a digest of each tool's description and input schema, and every later list is compared against it, so a rewritten description, a new tool or a removed one is reported. The comparison is local and sends nothing anywhere, and it never withholds the list, because a client that cannot read the tool list cannot call anything. `agent-chaperone trust <server>` accepts a change. `screen_tool_list` turns it off per server, separately from the screens that talk to a model.
- a205d59: Screen a Streamable HTTP upstream the same way as a stdio one. A URL in place of a command wraps the server at that URL, with the same policy file, thresholds, audit log and hold flow a local server gets, because the HTTP transport presents itself to the relay as the same pair of streams a child process would. `--header` sends a request header and `--header-env` reads its value from the environment, so a token stays out of the process list. A URL with no `--server` answers to its host in the policy file.

### Patch Changes

- a205d59: Act on a deterministic finding when no model was asked. A call that the rules layer flagged as a destructive shell form was held in enforce mode if a screening request had failed, but forwarded if no backend was configured at all, which made running with no key less protective than running with a key that does not work. Both cases now take the same path. A denied call is also reported as the deny list catching it, keeping the name of the pattern that matched, rather than as merely unscreened.

## 0.1.0

### Minor Changes

- First published release. Screens an AI agent's tool calls before they run and the tool results those calls return before the agent reads them, over MCP through a transparent proxy and over a client's own shell, file edits and web fetches through a hooks adapter. Deterministic rules and a battery of calibrated judgments decide together, every threshold lives in a policy file, and every decision is written to a local log with the probabilities behind it. Starts in shadow mode, which blocks nothing.
