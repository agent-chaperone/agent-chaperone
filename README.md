# agent-chaperone

> A calibrated firewall for AI agent tool calls.

[![CI](https://github.com/agent-chaperone/agent-chaperone/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-chaperone/agent-chaperone/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agent-chaperone/agent-chaperone/blob/main/LICENSE)

**Status:** design and benchmark stage. The proxy is not implemented and nothing is published to npm. This page describes what is being built and what has been measured so far.

## What it does

agent-chaperone screens an AI agent's tool calls before they run, and the tool results those calls return before the agent reads them.

It reaches that traffic two ways, and both are in the first release. The primary one is a transparent Model Context Protocol proxy: one line in a client config wraps any MCP server, and every tool call and tool result crossing it is screened. The second is a hooks adapter, because clients such as Claude Code, Cursor and Codex run their own built-in tools for shell commands, file edits and web fetches, and those never travel over MCP. A proxy cannot see them, and on those clients they are where most of the damage lives. The adapter exposes the same screens as commands a client's pre-tool and post-tool hooks call, against the same policy file and the same audit log.

Each screen combines deterministic rules in code with a small battery of typed, calibrated judgments from [Jev](https://docs.typesafe.ai), TypeSafe's System One model. Every judgment comes back as a probability. Every threshold lives in a policy file, not in a prompt. Every decision is written to a local audit log with the probabilities that produced it, so thresholds can be tuned on real traffic without re-running anything.

Screening sends the tool arguments and tool results being screened to the configured model backend, so that content leaves the machine. Secret-shaped strings are redacted before anything is sent, and screening can be turned off per server for content that has to stay local.

Three screens:

- **Pre-call.** Before a tool call is forwarded: is it destructive, does it send private data or secrets outside, does it break the policy written in plain English, how bad would it be if it ran.
- **Post-result.** Before a tool result reaches the agent: does the content try to instruct the AI reading it, which block does it, does it expose a secret, how much harm would following it cause.
- **Tool list.** When a server advertises its tools: do any descriptions carry instructions for the model beyond describing the tool, and have they changed since the user last approved the server.

Modes: `shadow` (default, logs every judgment and blocks nothing), `enforce`, and `strict`. Held calls can be approved from the terminal, or through MCP elicitation when the client supports it.

Wrapping a server is one change to the client's MCP configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "agent-chaperone", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

## What it is not

- **Not a sandbox.** It cannot stop a server from doing something the call did not describe. Pair it with OS-level isolation for that.
- **Not a replacement for the client's permission prompts.** It is a second opinion that sees the content, which permission prompts do not.
- **Not a guarantee.** The underlying model does not treat its input as hostile by default, and adaptive attacks written against this tool will get through. The benchmark below reports what it catches and what it misses.

## Measured so far

The screening questions were evaluated against public prompt-injection benchmarks and a hand-labeled set of tool calls, using `jev-1.13.0` on 2026-09-19, one request per item. The batteries sent were the ones the tool sends, question for question. The full run is 1,942 requests and costs $0.061 at the published price.

| Set | Items | Positives | AUC | Precision / recall at 0.5 | at 0.3 |
| --- | ---: | ---: | ---: | --- | --- |
| InjecAgent tool responses | 1,394 | 1,054 | 0.976 | 0.989 / 0.805 | 0.956 / 0.949 |
| BIPIA email | 250 | 200 | 1.000 | 1.000 / 0.825 | 1.000 / 0.850 |
| Discusses injection, benign | 63 | 0 | n/a | 7 false positives | 10 false positives |
| Hand-labeled tool calls | 100 | 51 | 0.993 | 0.980 / 0.961 | 0.909 / 0.980 |

Latency from a laptop was 405 ms median and 876 ms at the 95th percentile, with 753 input tokens per request on average.

Two questions the tool asks are not in these numbers. `policy_violation` and `off_task` are sent only when a policy or a task is configured, and no row here has either, so nothing above measures them.

The hand-labeled set leans toward the built-in tool case on purpose: 44 of the 100 scored calls are shell commands, and 26 of the 51 dangerous ones are. On the clients above, those are built-in tools rather than MCP traffic, so they reach the screens through the hooks adapter.

Methodology, per-threshold tables, the misses, and the raw recorded model responses are in [`bench/`](./bench/README.md).

## Design

- [`docs/design.md`](./docs/design.md): architecture, the three screens and their questions, policy file, audit log, privacy, and performance budget.
- [`docs/adr/`](./docs/adr/): the decisions behind the design and why.
- [`ROADMAP.md`](./ROADMAP.md): what lands in which version.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Agents and contributors can start from [`AGENTS.md`](./AGENTS.md) and [`CURRENT_STATE.md`](./CURRENT_STATE.md).

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
