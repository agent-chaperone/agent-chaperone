# agent-chaperone

## 0.1.0

### Minor Changes

- First published release. Screens an AI agent's tool calls before they run and the tool results those calls return before the agent reads them, over MCP through a transparent proxy and over a client's own shell, file edits and web fetches through a hooks adapter. Deterministic rules and a battery of calibrated judgments decide together, every threshold lives in a policy file, and every decision is written to a local log with the probabilities behind it. Starts in shadow mode, which blocks nothing.
