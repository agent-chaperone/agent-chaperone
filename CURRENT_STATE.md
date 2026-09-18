# CURRENT_STATE.md

> Living document, updated inside every PR before merge.

## Current Version

`0.0.0`, unreleased. The package is `private` and nothing is on npm.

## Active Milestone

**M0: Repository and Design Foundation.** See [`ROADMAP.md`](./ROADMAP.md).

## What's Done

### Tooling foundation

Single TypeScript package (ESM, strict, `NodeNext`), ESLint flat config with `typescript-eslint` strict and stylistic, Prettier, Vitest, Changesets config. `src/index.ts` is a placeholder that exports the package name, with one test so CI has something to run.

### CI and release

`ci.yml` runs lint, format check, typecheck, build, and test on pushes and pull requests to `main`. `release.yml` runs Changesets on `main` and creates a tag and GitHub release when a version is published. Publishing is inert while the package is `private`.

### Templates

Pull request template. Issue templates for bugs, features, and false positives or misses. The last one asks for the audit log line, because the probabilities and model version are what make a report actionable.

### Community and living docs

README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, ROADMAP, this file, and AGENTS.md.

### Design

`docs/design.md` and ADRs 0001 to 0005.

### Policy and decisions (#4)

The policy file schema fills in every threshold and rejects what would behave surprisingly, including an annotate threshold that quarantine would always reach first. `decidePreCall` and `decidePostResult` are pure, and shadow mode records what it decided while applying nothing.

### Proxy relay (#3)

Spawns the upstream server over stdio and relays every message in both directions exactly as it arrived, pairing each response with the request that produced it. Nothing is screened: `createProxy` takes an `onEvent` callback, and that callback is the seam the screens attach to in #8.

### Deterministic layer (#5)

Allow and deny matching, dangerous shell forms, secret redaction, hidden-text detection and the block splitter the post-result question needs. It runs before any model request and costs nothing, which is what the tool does when no API key is configured. Not wired to the proxy yet; that is #8.

### Model backends (#6)

One interface for asking a model a battery of typed questions, with the question and answer shapes owned by this package rather than by a vendor, so the backends that land in v0.2.0 fit without changing it. The TypeSafe implementation configures the SDK's retries and `Retry-After` handling and adds a budget for the whole call, because a screen sits in front of a tool call the agent is waiting on. It never throws: a missing key, a rate limit, a timeout and a malformed response all arrive as results the policy can act on, which is what lets shadow and enforce modes differ on what to do when a screen cannot run. Answers are validated against the battery that asked for them before anything reads a number, and nothing a server wrote is copied into a failure message or into a stored model version, because both reach the audit log and the agent can be shown the audit log. Tests run against a fake that replays recordings keyed by a hash of the request and throws on a request it has no recording for.

### Screens (#7)

A tool call and a tool result turned into the exact request the harness sent, and the answers read back into the shape the decision rules take. The question wording lives in one file, one constant per question, transcribed from `bench/src/run.py`; a test reads that file and asserts each shipped string still appears in it, so the claim that the wording is the measured wording is checked rather than promised. With a tool and arguments and nothing else, the pre-call state is field for field what the benchmark sent. A policy, a task or the server's annotations are additions to that request, and the questions naming them are added with them. Results larger than one request are chunked with the block numbering of the whole result preserved, and the verdict is the maximum across chunks so a long benign document cannot bury one injected paragraph. Fixtures are real recorded answers from the run the README quotes, and a test checks each one back against the row it names in `bench/results/cache.jsonl`.

The harness now sends the batteries the tool sends, so the README's numbers describe the shipping request rather than a subset of it. Re-running it moved the numbers very little: AUC is unchanged on all four sets, recall on InjecAgent went up slightly and on BIPIA down slightly, and the benign documentation set gained one false positive at 0.5. The two questions that ship only with a policy or a task are still unmeasured.

### Screening, wired to the proxy (#8)

The relay now asks a gate before it writes. A gate returning a verdict rather than a promise is written in the same turn it arrived, so traffic that is not screened pays nothing; anything awaited is queued so messages leave in the order they came, the source stops being read while a decision is pending, and a direction does not close until what it is holding has landed. A withheld call is answered to the client rather than silently dropped, because a client waiting on a request the server never received waits forever.

`screening/` is where the layers meet: the deterministic rules settle what they can without a request, what is left becomes one backend call, and the answers become an action the policy chose. Shadow records what it decided and applies nothing, enforce acts, and strict fails closed, including when the backend raises rather than returning a failure. With no API key the rules are the whole screen and every judgment says so, so a forward is never mistaken for an all-clear.

The CLI wires it up: it reads the policy file, picks a backend, and screens a real session. Judgments go to stderr as JSON lines until the audit log gives them a home.

### Audit log (#9)

One JSONL line per screened message, in a per-session file under the user's state directory, created for the owner alone. The record carries what the decision was made from and not only what it was, because `replay` reads the same lines later: every probability, the action the policy chose beside the one that was applied, the model, the latency, the tokens and the cost. Content is stored as it went to the model, which is to say already redacted, and `--no-store-content` keeps the judgments and drops it. A log that cannot be written says so once and stops trying, because a firewall that refuses to relay because its disk filled up has turned a full disk into an outage.

`agent-chaperone log` prints what has been decided, one readable line each, saying what was done and what the policy would have done instead, and `--follow` keeps printing. It reads every session, because a client normally wraps several servers and each is its own process. That comparison is the point of shadow mode: it is how a user sees where their thresholds sit on their own traffic before turning enforcement on. `agent-chaperone show <id>` prints what was held or withheld, which is the copy the agent never received.

### Benchmark

`bench/` holds the harness that evaluated the screening questions against InjecAgent, BIPIA, deepset, a benign "discusses injection" set, and 119 hand-labeled tool calls, with 1,942 recorded responses from `jev-1.13.0` (2026-09-18). The scorer runs from the recorded responses without a key. Headline numbers are in the README; the full report is in `bench/results/report.txt` and `bench/results/analysis.txt`.

## What's In Progress

Nothing in flight. A session is screened and recorded; what is missing is how a held call gets resumed, and the tools that never go through MCP.

## What's Next

M1, in dependency order:

1. `cli` (#10): hold and approve flow, `approve` command.
2. `hooks` (#11): adapter for clients whose built-in tools bypass MCP.
3. `docs` (#12): the v0.1.0 README, which is also what first publishes to npm.

## Known Blockers / Decisions Pending

- The MCP SDK's stdio transports cannot be used for the relay. Their framing validates each message against `JSONRPCRequestSchema`, which is strict, so a request carrying an unknown top-level field is rejected outright. The proxy does its own newline framing and relays the original line, which is why a protocol extension survives it. Recorded as [ADR-0006](docs/adr/0006-own-stdio-framing.md).

- `policy_violation` and `off_task` are unmeasured. They are asked only when a policy or a task is configured, and no benchmark row carries either, so measuring them needs labeled policies and tasks that do not exist yet.

- Whether the post-result state should include the agent's tool list. The benchmark showed that attacks phrased as polite requests ("please unlock my front door") score low because the model cannot know which tools exist. To be measured in M3 before changing the M1 battery.
- Where the annotate threshold sits on real traffic. Shadow mode exists to answer this; defaults ship from measured distributions.

## Package Status Table

| Area | Status |
| --- | --- |
| Tooling, CI, templates, docs | done |
| Design document and ADRs | done |
| Benchmark harness and results | done |
| proxy | relay done (#3), screening wired in (#8) |
| policy | done (#4), consulted on every message (#8) |
| rules | done (#5), consulted on every message (#8) |
| backends | done (#6), asked on every screen (#8) |
| screens | done (#7), built on every screen (#8) |
| screening | done (#8) |
| audit | done (#9) |
| cli | wraps, screens, `log` and `show` (#8, #9), approve pending (#10) |
| hooks | not started |
