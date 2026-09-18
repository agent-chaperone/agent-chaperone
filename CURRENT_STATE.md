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

### Benchmark

`bench/` holds the harness that evaluated the screening questions against InjecAgent, BIPIA, deepset, a benign "discusses injection" set, and 119 hand-labeled tool calls, with 1,942 recorded responses from `jev-1.13.0` (2026-09-18). The scorer runs from the recorded responses without a key. Headline numbers are in the README; the full report is in `bench/results/report.txt` and `bench/results/analysis.txt`.

## What's In Progress

Nothing. M0 is complete once this scaffold lands on `main` with CI green.

## What's Next

M1, in dependency order:

1. `proxy`: stdio child transport, JSON-RPC passthrough, request and response correlation, fake upstream and fake client test harness.
2. `policy`: YAML schema, defaults, validation, pure decision functions for both screens.
3. `rules`: allow and deny lists, dangerous shell patterns, secret redaction, hidden-text detection, block splitting.
4. `backends`: backend interface, TypeSafe implementation, recorded-response fake for tests.
5. `screens`: pre-call and post-result state builders and batteries, wired into the proxy.
6. `audit`: JSONL writer, `log` and `show` commands.
7. `cli`: hold and approve flow, `approve` command, shadow and enforce modes end to end.
8. `hooks`: adapter for clients whose built-in tools bypass MCP.

## Known Blockers / Decisions Pending

- Whether the post-result state should include the agent's tool list. The benchmark showed that attacks phrased as polite requests ("please unlock my front door") score low because the model cannot know which tools exist. To be measured in M3 before changing the M1 battery.
- Where the annotate threshold sits on real traffic. Shadow mode exists to answer this; defaults ship from measured distributions.

## Package Status Table

| Area | Status |
| --- | --- |
| Tooling, CI, templates, docs | done |
| Design document and ADRs | done |
| Benchmark harness and results | done |
| proxy | not started |
| policy | not started |
| rules | not started |
| backends | not started |
| screens | not started |
| audit | not started |
| cli | not started |
| hooks | not started |
