# Roadmap

> agent-chaperone: a calibrated firewall for AI agent tool calls.

Each milestone maps to a semantic version. Versions before 1.0 may change the policy file format and the CLI between minor releases; each such change is called out in the changelog.

---

## M0: Repository and Design Foundation

**Status:** in progress

Tooling, CI, templates, community docs, the design document, the architecture decision records, and the screening benchmark, before any proxy code lands.

- Single TypeScript package, strict config, ESLint, Prettier, Vitest
- GitHub Actions CI and a Changesets release workflow
- PR and issue templates, including one for false positives and misses
- README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, AGENTS.md, CURRENT_STATE.md
- Design document and ADRs 0001 to 0005
- Benchmark harness with recorded results for the screening questions

**Exit criteria:** `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` pass. CI green on `main`. Benchmark reproduces from the recorded responses without an API key.

---

## M1: v0.1.0, a working proxy

**Status:** not started

The smallest version that protects a real session.

- stdio proxy wrapping a child MCP server, passthrough for everything it does not screen
- Pre-call screen: deterministic rules, secret redaction, the Jev battery, and the decision function
- Post-result screen: hidden-text detection, block splitting, the Jev battery, and pass, annotate, or quarantine
- `shadow` and `enforce` modes
- Hold and approve flow through an error result and `agent-chaperone approve`
- Policy file: mode, thresholds, allow and deny lists, per-server overrides, redaction patterns
- JSONL audit log, `log`, `show`, and `approve` commands
- TypeSafe backend, rules-only fallback when no key is configured
- Hooks adapter so clients whose built-in tools bypass MCP get the same screens
- Recorded-response tests for every decision path, integration tests with a fake upstream server and a fake client

**Exit criteria:** an agent that fetches a page containing a hidden instruction sees it quarantined, and a destructive shell call is held and then approved from the terminal, both visible in the audit log.

---

## M2: v0.2.0, every client and every transport

**Status:** not started

- Streamable HTTP upstream servers
- Elicitation-based confirmation when the client supports it
- Tool-list screen with description hashing and change warnings
- `wrap` command that edits the common client configurations in place
- OpenRouter and Vercel AI Gateway backends
- `report` and `replay` commands
- Judgment cache keyed by content hash, chunking for large results
- `task` command and a hook example that records the current task

---

## M3: v0.3.0, receipts and tuning

**Status:** not started

- Benchmark suite runnable from the repo with committed raw responses and reliability diagrams
- Post-result screen that includes the agent's tool list in the state, measured against the same benchmarks
- Expanded benign sets: documentation about prompt injection, security tool READMEs, code that contains question text
- Default thresholds chosen from the measured distributions and documented
