# ADR-0001: Transparent MCP Proxy First, Hooks Adapter for Built-in Tools

## Status

Accepted

## Context

Screening tool traffic can be done at three places: inside each MCP server (not portable), inside each client through its hook system (client-specific, and not every client has hooks), or between client and server as a proxy that speaks MCP on both sides (works with any client and any server, but sees only what the protocol carries).

Several clients also run built-in tools (shell, file edits, web fetch) outside MCP entirely. A proxy never sees those, and for those clients they are where most damage happens.

## Decision

The proxy is the primary integration. It wraps a server with one change to the client's configuration and needs nothing from the client beyond MCP. A hooks adapter exposes the same screens as commands that a client's pre-tool and post-tool hooks can call, so clients with built-in tools get the same judgments, policy, and audit log. Both ship in the first release.

## Consequences

- One configuration line protects any MCP server in any client.
- The proxy sees JSON-RPC traffic, not the conversation. Judgments about the user's intent need the `task` file or a hook that records the prompt.
- The hooks adapter is per client and follows each client's hook contract; the proxy does not.
- Neither is a sandbox. The design says so, and the README says so first.
