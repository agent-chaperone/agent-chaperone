# AGENTS.md

> Repository guide for coding agents and new contributors. Tool-neutral. Point your agent here to get productive quickly.
>
> This is the only file of its kind. `CLAUDE.md` imports it rather than repeating it, because Claude Code reads that name and not this one.

## Project Overview

agent-chaperone is a transparent proxy for the Model Context Protocol. It screens tool calls before an MCP server runs them and tool results before the agent reads them, using deterministic rules plus calibrated judgments from Jev, TypeSafe's System One model. Decisions are probabilities compared against thresholds in a policy file, and every decision is logged.

**License:** Apache-2.0 **Language:** TypeScript (strict), ESM only **Package Manager:** pnpm 10.x **Node:** >= 20.0.0 **Benchmark harness:** Python >= 3.10 with `uv`, under `bench/`

## Repository Structure

```
agent-chaperone/
  src/
    index.ts     Public entry point
    proxy/       Transport plumbing, framing, request and response correlation
    cli/         Command line entry point
    screens/     State builders and question batteries              (#7)
    rules/       Deterministic checks, redaction, hidden text        (#5)
    policy/      Schema, thresholds, pure decision functions         (#4)
    backends/    Model backend interface and implementations         (#6)
    audit/       JSONL writer, report, replay                        (#9)
    hooks/       Adapter for a client's built-in tools               (#11)
  bench/
    src/         Set builders, runner, scorer
    results/     Recorded model responses and reports
  docs/
    design.md    Architecture, screens, policy, audit, privacy
    adr/         Architecture decision records
  .github/       CI, release, templates
```

Directories marked with an issue number do not exist yet and arrive with that
piece of work. The relay in `proxy/` has landed; the screening that attaches to
it has not. `cli/` is a minimal entry point, not the full command set.

## Build Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Compile to dist/
pnpm test             # Run tests
pnpm lint             # ESLint
pnpm typecheck        # tsc --noEmit
pnpm format           # Prettier, write
pnpm format:check     # Prettier, check only
pnpm changeset        # Add a changeset for release
```

Before opening a pull request, run them in the order CI runs them:

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test
```

CI stops at the first failure, so a formatting problem hides every result after it. `pnpm format:check` only reports; `pnpm format` applies the fixes.

Benchmark:

```bash
cd bench
uv venv .venv && uv pip install --python .venv/bin/python typesafe-sdk
bash fetch.sh                      # download public datasets
.venv/bin/python src/build_sets.py # build labeled sets
.venv/bin/python src/score.py      # score recorded responses, no key needed
```

## Testing Conventions

- Vitest. `*.test.ts` next to the code it tests.
- No test calls the TypeSafe API. Model responses are recorded fixtures.
- Proxy paths are tested against a fake upstream server and a fake client.
- Decision functions are pure and tested exhaustively on answer and policy combinations.

## Commit Conventions

Conventional Commits with a body that explains why:

```
feat(screens): add the post-result battery
fix(policy): validate threshold ranges
docs: describe quarantine output
chore: bump dependencies
test(proxy): cover hold and approve
```

Scopes: `proxy`, `screens`, `rules`, `policy`, `backends`, `audit`, `cli`, `hooks`, `bench`.

Branches: `feat/<scope>-<description>`, `fix/<scope>-<description>`, `chore/<description>`, `docs/<description>`, `test/<description>`.

## PR Conventions

- Work from an issue and a feature branch. Never commit to `main`, not for a one-line fix and not for docs.
- One concern per PR. Code, tests, docs, config, and changeset together.
- Stage files by explicit path rather than with `git add -A`, so unrelated work in the tree cannot ride along. `bench/.env`, `bench/data/` and `bench/.venv/` are ignored and stay that way.
- Tests required for the behavior introduced.
- Changeset required when published package behavior changes.
- `CURRENT_STATE.md` updated inside the PR. `AGENTS.md` updated if the architecture or build commands change.
- CI must be green.

## Code Style

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any` without a comment.
- Prettier: single quotes, trailing commas, 100 columns.
- ESLint: `typescript-eslint` strict and stylistic.
- `import type` for type-only imports.
- Decision functions are pure: answers and policy in, an action out. Side effects live in the proxy and audit layers. Keep model questions in one place per screen so a wording change is a reviewable diff, and re-measure it with the harness in `bench/` before it ships. The numbers in the README came from the exact wording in `docs/design.md`.

## Security Constraints

- Tool arguments, tool results, tool descriptions, resource bodies, policy files, and configuration are untrusted. Validate with Zod, enforce size limits, parse JSON in try/catch.
- No `eval()`, `Function()`, or shell interpolation of content.
- Redact secret-shaped strings before sending content to a backend and before writing the audit log.
- API keys come from the environment only. Never log them.
- No personal data in committed fixtures. Benchmark datasets are downloaded at build time; recorded responses carry no content.

## Design Decisions

See [`docs/adr/`](./docs/adr/) and [`docs/design.md`](./docs/design.md). In short:

- Transparent MCP proxy first, hooks adapter for built-in tools (ADR-0001).
- The relay does its own newline framing instead of using the MCP SDK's stdio transports, because those validate strictly and would refuse messages carrying unknown fields (ADR-0006).
- Shadow mode by default, fail-open unless strict (ADR-0002).
- The instruction probability alone gates a result; severity picks annotate versus quarantine (ADR-0003).
- Benchmarks use public datasets and hand-labeled calls, with raw responses committed and the model version pinned (ADR-0004).
- Screened content leaves the machine; redaction, per-server opt-out, and size caps limit what does (ADR-0005).

## Where to Look

| Question | File |
| --- | --- |
| What is built, what is next | [`CURRENT_STATE.md`](./CURRENT_STATE.md) |
| How the proxy, screens, policy and audit log fit together | [`docs/design.md`](./docs/design.md) |
| Why the design is the way it is | [`docs/adr/`](./docs/adr/) |
| How the numbers were measured, and how to reproduce them without a key | [`bench/README.md`](./bench/README.md) |
| Setup and the contribution workflow | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| What lands in which version | [`ROADMAP.md`](./ROADMAP.md) |
