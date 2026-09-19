# Roadmap

> agent-chaperone: a calibrated firewall for AI agent tool calls.

Each milestone maps to a semantic version. Versions before 1.0 may change the policy file format and the CLI between minor releases; each such change is called out in the changelog.

---

## M0: Repository and Design Foundation

**Status:** done

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

**Status:** released

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

## M2: v0.2.0, remote servers and a watch on the tool list

**Status:** released

Reaching servers that are not a local process, and noticing when a server stops being the one you installed.

- Streamable HTTP upstream servers, screened by the same code as a stdio server
- Tool-list comparison: a digest of each tool's description and input schema, recorded on first sight and compared on every later list, with `agent-chaperone trust <server>` to accept a change
- `screen_tool_list` as a per-server switch, separate from the screens that talk to a model
- A deterministic finding is acted on when no model was asked, so running with no key is no less protective than running with one that fails

**Exit criteria:** an agent pointed at a Streamable HTTP server has its calls and results screened exactly as a local one does, and a server that rewrites a tool description between sessions is reported.

---

## M3: v0.3.0, every client

**Status:** not started

- Elicitation-based confirmation when the client supports it

---

## M4: v0.4.0, receipts and tuning

**Status:** not started

- Benchmark suite runnable from the repo with committed raw responses and reliability diagrams
- Post-result screen that includes the agent's tool list in the state, measured against the same benchmarks
- Expanded benign sets: documentation about prompt injection, security tool READMEs, code that contains question text
- Default thresholds chosen from the measured distributions and documented
