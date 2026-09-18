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

### Benchmark

`bench/` holds the harness that evaluated the screening questions against InjecAgent, BIPIA, deepset, a benign "discusses injection" set, and 119 hand-labeled tool calls, with 1,942 recorded responses from `jev-1.13.0` (2026-09-18). The scorer runs from the recorded responses without a key. Headline numbers are in the README; the full report is in `bench/results/report.txt` and `bench/results/analysis.txt`.

## What's In Progress

Nothing in flight. Everything M1 needs before the screens is in place: the rules, the policy, the relay and the backend.

## What's Next

M1, in dependency order:

1. `screens` (#7): pre-call and post-result state builders and batteries.
2. `proxy` (#8): wire the screens in, with shadow and enforce modes.
3. `audit` (#9): JSONL writer, `log` and `show` commands.
4. `cli` (#10): hold and approve flow, `approve` command.
5. `hooks` (#11): adapter for clients whose built-in tools bypass MCP.
6. `docs` (#12): the v0.1.0 README, which is also what first publishes to npm.

## Known Blockers / Decisions Pending

- The MCP SDK's stdio transports cannot be used for the relay. Their framing validates each message against `JSONRPCRequestSchema`, which is strict, so a request carrying an unknown top-level field is rejected outright. The proxy does its own newline framing and relays the original line, which is why a protocol extension survives it. Recorded as [ADR-0006](docs/adr/0006-own-stdio-framing.md).

- Whether the post-result state should include the agent's tool list. The benchmark showed that attacks phrased as polite requests ("please unlock my front door") score low because the model cannot know which tools exist. To be measured in M3 before changing the M1 battery.
- Where the annotate threshold sits on real traffic. Shadow mode exists to answer this; defaults ship from measured distributions.

## Package Status Table

| Area | Status |
| --- | --- |
| Tooling, CI, templates, docs | done |
| Design document and ADRs | done |
| Benchmark harness and results | done |
| proxy | relay done (#3), screening pending (#8) |
| policy | schema and decision functions done (#4), not yet consulted (#8) |
| rules | done (#5), not yet consulted (#8) |
| backends | done (#6), not yet consulted (#8) |
| screens | not started |
| audit | not started |
| cli | minimal entry point done, commands pending (#10) |
| hooks | not started |
