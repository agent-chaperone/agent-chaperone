# AGENTS.md

> Repository guide for coding agents and new contributors. Tool-neutral. Point your agent here to get productive quickly.

## Project Overview

agent-chaperone is a transparent proxy for the Model Context Protocol. It screens tool calls before an MCP server runs them and tool results before the agent reads them, using deterministic rules plus calibrated judgments from Jev, TypeSafe's System One model. Decisions are probabilities compared against thresholds in a policy file, and every decision is logged.

**License:** Apache-2.0 **Language:** TypeScript (strict), ESM only **Package Manager:** pnpm 10.x **Node:** >= 20.0.0 **Benchmark harness:** Python >= 3.10 with `uv`, under `bench/`

## Repository Structure

```
agent-chaperone/
  src/
    index.ts          Public entry point (placeholder until M1)
  bench/
    src/              Set builders, runner, scorer
    results/          Recorded model responses and reports
  docs/
    design.md         Architecture, screens, policy, audit, privacy
    adr/              Architecture decision records
  .github/            CI, release, templates
```

Planned layout for `src/` once implementation starts (see `docs/design.md`):

```
src/
  proxy/      transport plumbing, request and response correlation
  screens/    precall.ts, postresult.ts, toollist.ts (state builders and batteries)
  rules/      deterministic checks, redaction, hidden-text detection
  policy/     YAML schema, thresholds, pure decision functions
  backends/   typesafe.ts, openrouter.ts, vercel.ts behind one interface
  audit/      JSONL writer, report, replay
  hooks/      adapter for clients whose built-in tools bypass MCP
  cli/        wrap, log, report, show, approve, task
```

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

- One concern per PR. Code, tests, docs, config, and changeset together.
- Tests required for the behavior introduced.
- Changeset required when published package behavior changes.
- `CURRENT_STATE.md` updated inside the PR. `AGENTS.md` updated if the architecture or build commands change.
- CI must be green.

## Code Style

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any` without a comment.
- Prettier: single quotes, trailing commas, 100 columns.
- ESLint: `typescript-eslint` strict and stylistic.
- `import type` for type-only imports.
- Keep policy decisions in pure functions. Keep model questions in one place per screen so wording changes are reviewable diffs.

## Security Constraints

- Tool arguments, tool results, tool descriptions, resource bodies, policy files, and configuration are untrusted. Validate with Zod, enforce size limits, parse JSON in try/catch.
- No `eval()`, `Function()`, or shell interpolation of content.
- Redact secret-shaped strings before sending content to a backend and before writing the audit log.
- API keys come from the environment only. Never log them.
- No personal data in committed fixtures. Benchmark datasets are downloaded at build time; recorded responses carry no content.

## Design Decisions

See [`docs/adr/`](./docs/adr/) and [`docs/design.md`](./docs/design.md). In short:

- Transparent MCP proxy first, hooks adapter for built-in tools (ADR-0001).
- Shadow mode by default, fail-open unless strict (ADR-0002).
- The instruction probability alone gates a result; severity picks annotate versus quarantine (ADR-0003).
- Benchmarks use public datasets and hand-labeled calls, with raw responses committed and the model version pinned (ADR-0004).
- Screened content leaves the machine; redaction, per-server opt-out, and size caps limit what does (ADR-0005).

## Current Status

See [`CURRENT_STATE.md`](./CURRENT_STATE.md).
