# Contributing to agent-chaperone

Thanks for your interest. This document covers setup, conventions, and the contribution workflow.

## Getting Started

### Prerequisites

- **Node.js** >= 20.0.0
- **pnpm** 10.x (`npm install -g pnpm`)
- **Git**
- For the benchmark harness only: **Python** >= 3.10 and [`uv`](https://github.com/astral-sh/uv)

### Local Setup

```bash
git clone https://github.com/agent-chaperone/agent-chaperone.git
cd agent-chaperone
pnpm install

# The same checks CI runs, in the same order
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

## Repository Layout

```
agent-chaperone/
  src/            TypeScript source (single package, ESM)
  bench/          Screening benchmark harness (Python) and recorded results
  docs/           Design document and architecture decision records
  .github/        CI, release workflow, issue and PR templates
```

See [`AGENTS.md`](./AGENTS.md) for the module layout inside `src/` as it takes shape, and [`docs/design.md`](./docs/design.md) for the architecture.

## Development Workflow

### 1. Find or Create an Issue

All work is tracked in GitHub Issues. Check existing issues or open one with the matching template (bug report, feature request, false positive or miss).

### 2. Create a Branch

```bash
git checkout -b feat/<scope>-<description>
```

### 3. Make Your Changes

- Follow the code style (TypeScript strict, Prettier, ESLint).
- Write tests for the behavior you introduce. Screening logic is tested against recorded model responses, never against the live API.
- Update `CURRENT_STATE.md` and, if the architecture changed, `AGENTS.md`, inside the same branch.

### 4. Verify Locally

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

CI stops at the first failure, so a formatting problem hides every result after it. `pnpm format:check` only reports; `pnpm format` applies the fixes.

### 5. Add a Changeset

If your PR changes published package behavior:

```bash
pnpm changeset
```

### 6. Open a Pull Request

- Use the PR template.
- Link the issue. Write `Closes #N` only when the PR fully resolves it.
- CI must be green.

## Conventions

### Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/), subject plus a body that explains why:

```
feat(proxy): forward tools/call through the pre-call screen
fix(policy): reject thresholds outside 0..1
docs: describe the hold and approve flow
chore: bump vitest
test(screens): add recorded responses for the post-result battery
```

Scopes: `proxy`, `screens`, `rules`, `policy`, `backends`, `audit`, `cli`, `hooks`, `bench`.

### Branch Naming

```
feat/<scope>-<description>
fix/<scope>-<description>
chore/<description>
docs/<description>
test/<description>
```

### Code Style

- TypeScript strict mode. No `any` without a comment saying why.
- Prettier for formatting (single quotes, trailing commas, 100 columns).
- ESLint with `typescript-eslint` strict and stylistic rules.
- `import type` for type-only imports.
- Decision functions are pure: they take answers and policy and return an action. Side effects live in the proxy and audit layers.

### Testing

- Vitest. Test files are `*.test.ts` next to the code they test.
- No test talks to the TypeSafe API. Record responses as fixtures and replay them. A fake upstream MCP server and a fake client cover the proxy paths.

## Untrusted Input

Tool arguments, tool results, tool descriptions, resource bodies, policy files, and configuration are all untrusted. Every entry point validates shape with Zod, enforces size limits, parses JSON inside try/catch, and never evaluates content as code. Error messages shown to users or returned to agents do not include internal paths or stack traces.

## AI-Assisted Development

Maintainers may use AI-assisted development tools, but all contributions must be reviewed, tested, documented, and scoped like normal engineering work. AI-generated code is held to the same standards as any other contribution: it must pass CI, include tests, be security-reviewed, and be understandable by a human reviewer.

Contributors using AI agents can point them at `AGENTS.md` for a structured overview of this repository's architecture, conventions, and build system. `CURRENT_STATE.md` reflects what has been built so far and what is in progress.

No AI tool preference is assumed or required. The project does not endorse any specific AI tool.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
