# agent-chaperone

> A calibrated firewall for AI agent tool calls.

[![npm](https://img.shields.io/npm/v/agent-chaperone.svg)](https://www.npmjs.com/package/agent-chaperone) [![CI](https://github.com/agent-chaperone/agent-chaperone/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-chaperone/agent-chaperone/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/agent-chaperone/agent-chaperone/blob/main/LICENSE)

agent-chaperone screens an AI agent's tool calls before they run, and the tool results those calls return before the agent reads them. Every decision comes back as a probability, every threshold lives in a policy file rather than a prompt, and every judgment is written to a local log with the numbers that produced it.

It starts in `shadow` mode, which blocks nothing. You read your own log first and decide what you would have wanted stopped.

## What it is not

Read this part before the rest.

- **Not a sandbox.** It cannot stop a server from doing something the call did not describe. Pair it with OS-level isolation for that.
- **Not a replacement for the client's permission prompts.** It is a second opinion that sees the content, which permission prompts do not. It never auto-approves anything on your behalf.
- **Not a guarantee.** The underlying model does not treat its input as hostile by default, and adaptive attacks written against this tool will get through. The numbers below report what it catches and what it misses, including the misses.
- **Not local-only.** Screening sends the arguments and results being screened to the configured model backend, so that content leaves the machine. Secret-shaped strings are redacted first, and screening can be turned off per server for content that has to stay local.

## Install

```bash
npm install -g agent-chaperone
```

Screening needs `TYPESAFE_API_KEY` in the environment. Without it the deterministic rules still run, which is the allow and deny lists and the secret patterns, and every judgment records that no model was asked.

## Wrapping an MCP server

One change to the client's MCP configuration. Everything after `--` is the server that would have run anyway:

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

## Screening a client's own tools

A proxy sees MCP traffic. It does not see the shell, the file edits or the web fetches a client runs itself, and on the clients people actually use those are where most of the damage lives. Two commands read a client's hook payload and answer on stdout, against the same policy file and the same log.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Edit|Write|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook pre" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|PowerShell|Read|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook post" }]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash|PowerShell|Read|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook post" }]
      }
    ]
  }
}
```

The worked configuration, what each command answers, and what the hooks do not see are in [`docs/hooks.md`](./docs/hooks.md).

## The three modes

| Mode | What it does |
| --- | --- |
| `shadow` | Screens everything, blocks nothing. Every judgment is logged, including what it would have done. This is the default. |
| `enforce` | Acts on the judgments. Holds a call for your approval, blocks what the policy denies, and withholds a result that reads as an instruction. |
| `strict` | The same, and additionally stops rather than continuing when a screen could not run at all. |

### Moving from shadow to enforce

Run in `shadow` for a while and read what it would have done:

```bash
agent-chaperone log
```

```
14:03:11 call   forward  read_file  destructive 0.02 exfiltration 0.01 $0.000029
14:03:11 call   forward  write_file (would have held it)  destructive 0.91 severity 2.0 $0.000029
14:03:11 result WITHHELD fetch  instructs_reader 0.97 $0.000029
```

The `(would have held it)` column is the whole point of shadow mode: it is the list of things that change when you switch. Read them, and if you disagree with one, move the threshold rather than the mode. When the log stops surprising you, set `mode: enforce` in the policy file.

`agent-chaperone log --follow` watches a running session, and `agent-chaperone show <id>` prints what was held or withheld.

## When a call is held

In `enforce` and `strict`, a call that crosses a threshold does not run. The agent is told so, in terms it can act on:

```
agent-chaperone held this call to write_file for the user to approve: it looks like
it changes something in a way that is hard to undo. The possible damage was rated
high. Nothing ran. The user can allow it by running: agent-chaperone approve b2c4e6a8f0
```

The agent has not been told to try something else, and it has not been told the call failed. It has been told a person is deciding.

You then look at what it actually wanted to do, and allow it if you agree:

```bash
agent-chaperone show b2c4e6a8f0
agent-chaperone approve b2c4e6a8f0
```

The token names that one call rather than that tool, keyed by a digest of the server, the tool and the arguments as they arrived. Agreeing to a write to one path does not release a write to another. It is spent the moment it is used, and it expires. A tool the policy denies outright is not approvable: that is a standing rule you wrote, not a question you were asked, and the command says so and points at the policy file.

## The three screens

- **Pre-call.** Before a tool call is forwarded: is it destructive, does it send private data or secrets outside, does it break the policy written in plain English, how bad would it be if it ran.
- **Post-result.** Before a tool result reaches the agent: does the content try to instruct the AI reading it, which block does it, does it expose a secret, how much harm would following it cause.
- **Tool list.** When a server advertises its tools: do any descriptions carry instructions for the model beyond describing the tool, and have they changed since you last approved the server.

Each screen combines deterministic rules in code with a small battery of typed, calibrated judgments from [Jev](https://docs.typesafe.ai), TypeSafe's System One model.

## Commands

```
agent-chaperone [options] -- <command> [args...]   Wrap and screen a server
agent-chaperone log [--follow]                     Read this session's decisions
agent-chaperone show <id>                          Print what was held or withheld
agent-chaperone approve <id>                       Let one held call through, once
agent-chaperone hook pre|post                      Screen a client's own tools, from a hook
```

| Option | Meaning |
| --- | --- |
| `--policy <path>` | Policy file. Default `~/.config/agent-chaperone/policy.yaml` |
| `--server <name>` | Which section of the policy applies. Default: the command name |
| `--no-store-content` | Record the judgments and not the arguments or results |

For the hook commands, which a client launches with a fixed command line, `AGENT_CHAPERONE_POLICY` sets the policy path and `AGENT_CHAPERONE_STORE_CONTENT=0` does what `--no-store-content` does.

## Measured results

The screening questions were evaluated against public prompt-injection benchmarks and a hand-labeled set of tool calls, using `jev-1.13.0` on 2026-09-19, one request per item. The batteries sent were the ones the tool sends, question for question. The full run is 1,942 requests and costs $0.061 at the published price.

| Set | Items | Positives | AUC | Precision / recall at 0.5 | at 0.3 |
| --- | ---: | ---: | ---: | --- | --- |
| InjecAgent tool responses | 1,394 | 1,054 | 0.976 | 0.989 / 0.805 | 0.956 / 0.949 |
| BIPIA email | 250 | 200 | 1.000 | 1.000 / 0.825 | 1.000 / 0.850 |
| Discusses injection, benign | 63 | 0 | n/a | 7 false positives | 10 false positives |
| Hand-labeled tool calls | 100 | 51 | 0.993 | 0.980 / 0.961 | 0.909 / 0.980 |

Each screened call costs one model request, averaging 753 input tokens. A call the allow or deny list settles never reaches the model.

Two questions the tool asks are not in these numbers. `policy_violation` and `off_task` are sent only when a policy or a task is configured, and no row here has either, so nothing above measures them.

The hand-labeled set leans toward the built-in tool case on purpose: 44 of the 100 scored calls are shell commands, and 26 of the 51 dangerous ones are. On the clients above, those are built-in tools rather than MCP traffic, so they reach the screens through the hooks adapter.

Methodology, per-threshold tables, the misses, and the raw recorded model responses are in [`bench/`](./bench/README.md).

## Design

- [`docs/design.md`](./docs/design.md): architecture, the three screens and their questions, policy file, audit log, privacy, and performance budget.
- [`docs/hooks.md`](./docs/hooks.md): screening a client's own tools.
- [`docs/adr/`](./docs/adr/): the decisions behind the design and why.
- [`ROADMAP.md`](./ROADMAP.md): what lands in which version.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Agents and contributors can start from [`AGENTS.md`](./AGENTS.md) and [`CURRENT_STATE.md`](./CURRENT_STATE.md).

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
