# CLAUDE.md

Guidance for coding agents working in this repository. The full repository guide is [`AGENTS.md`](./AGENTS.md); read it first, then [`CURRENT_STATE.md`](./CURRENT_STATE.md) for what exists and what is next. This file only repeats the parts an agent needs before its first edit.

## Before changing anything

- Work from an issue and a feature branch. Never commit to `main`.
- Run the checks CI runs, in the same order: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm test`.
- Tests never call the TypeSafe API. Record responses as fixtures and replay them. Proxy paths are tested against a fake upstream server and a fake client.
- Update `CURRENT_STATE.md` inside the same branch. Update `AGENTS.md` when the architecture or build commands change.
- Stage files by explicit path. `bench/.env`, `bench/data/`, and `bench/.venv/` are ignored and stay that way.

## Conventions

- Conventional Commits with a body that explains why. Scopes: `proxy`, `screens`, `rules`, `policy`, `backends`, `audit`, `cli`, `hooks`, `bench`.
- TypeScript strict with `noUncheckedIndexedAccess`, ESM only, Prettier settings from `.prettierrc`, `import type` for type-only imports.
- Decision functions are pure: answers and policy in, action out.
- Model questions live in one place per screen. A wording change is a reviewable diff and is re-measured with the harness in `bench/` before it ships; the current numbers in the README came from the exact wording in `docs/design.md`.

## Untrusted input

Tool arguments, tool results, tool descriptions, resource bodies, policy files, and configuration are untrusted. Validate with Zod, cap sizes, parse JSON inside try/catch, never evaluate content as code, and never log secrets or API keys. Error text shown to users or returned to agents carries no internal paths or stack traces.

## Where to look

- [`docs/design.md`](./docs/design.md): architecture, screens, policy, audit.
- [`docs/adr/`](./docs/adr/): why the design is the way it is.
- [`bench/README.md`](./bench/README.md): how the numbers were measured and how to reproduce them without a key.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md): setup and the contribution workflow.
