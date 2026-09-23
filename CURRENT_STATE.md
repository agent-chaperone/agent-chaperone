# CURRENT_STATE.md

> Living document, updated inside every PR before merge.

## Current Version

`0.3.2`. Published to npm as [`agent-chaperone`](https://www.npmjs.com/package/agent-chaperone).

## Active Milestone

**M4: v0.4.0, receipts and tuning.** See [`ROADMAP.md`](./ROADMAP.md).

## What's Done

### Tooling foundation

Single TypeScript package (ESM, strict, `NodeNext`), ESLint flat config with `typescript-eslint` strict and stylistic, Prettier, Vitest, Changesets config. `src/index.ts` is a placeholder that exports the package name, with one test so CI has something to run.

### CI and release

`ci.yml` runs lint, format check, typecheck, build, and test on pushes and pull requests to `main`. `release.yml` publishes and creates the tag and GitHub release. It runs only when a person starts it, and asks for the version to be typed back before it does anything, so merging never publishes.

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

### Hold and approve (#10)

A held call cannot wait for a client-specific interface, so the agent is handed a result it can relay: which tool was held, why, and the one command that releases it. `agent-chaperone approve <id>` writes a single-use token, the agent retries, and that attempt goes through. The one after it is held again.

The token names one call rather than one tool, keyed by a fingerprint of the server, the tool and the redacted arguments, so agreeing to a write to one path does not release a write to another. It is spent the moment it is read, and it expires, because a token left behind by a session that ended is a standing permission nobody remembers granting. A deny list is not approvable: that is a standing rule the user wrote, not a question they were asked, and the command says so and points at the policy file.

### Hooks adapter (#11)

`agent-chaperone hook pre` and `hook post` read a client's hook payload on stdin and answer on stdout, with the same policy, rules, questions, decisions and audit log as the proxy. This is the path to a client's own shell, file edits and web fetches, which never travel over MCP and are where most of the damage lives on the clients people use.

Four things came out of reading a client's published hook contract rather than assuming. A held call asks the client to prompt the user, because they are already at the keyboard. A forwarded call returns no decision rather than allowing, because allowing would skip the permission prompts the user set up. A replacement for a result must match that tool's output shape or it is discarded while the original reaches the model, so the replacement is derived from the shape that arrived rather than from a table of tools, and it is placed by walking the whole output rather than its top level, because a file read nests its contents and an MCP tool returns a bare array of blocks. And a failed tool is a separate event that accepts added context but no replacement, so its result can be annotated and never withheld.

Every replacement now travels with a note carried in its own field. A replacement that does not match a tool's own output schema is discarded without complaint while the original reaches the model, and nothing here can know every schema, so the note arrives whether or not the replacement is kept. Annotating keeps the result and adds a banner rather than replacing the body, on both the proxy and the hook path.

The worked configuration is in [`docs/hooks.md`](./docs/hooks.md).

The matchers name `Monitor` and `NotebookEdit` before a call and `Grep` after one (#76). Monitor runs commands under the same permission rules as Bash, a notebook cell is code that runs later, and Grep returns lines from files, which is how an injected instruction arrives through `Read` too. A matcher of plain names is exact, so `Edit` never covered `NotebookEdit`. The adapter needed no change for any of them, and a test against Grep's published output type shows a withheld result keeps the `mode` field the client checks. The README, `docs/hooks.md` and the plugin carry the same configuration, and a test fails when any of the three differs.

### Claude Code plugin (#74)

The hook configuration also ships as a Claude Code plugin: `/plugin marketplace add agent-chaperone/agent-chaperone`, then `/plugin install agent-chaperone@agent-chaperone`. It registers the same three entries as `docs/hooks.md`, a test keeps the two identical, and the skill under `skills/` comes along with no configuration of its own.

The hooks run `scripts/plugin-hook.mjs`. It starts a global `agent-chaperone` when one is on the path, and otherwise installs the matching version once into the plugin's data directory, with its own npm cache, and runs it directly after that: 13 seconds for the first call and a seventh of a second for each one after, measured. The version comes from the `package.json` in the same checkout, so the plugin has no version of its own to forget to bump. It never writes to stdout and never exits 2 for a failure of its own, because the first makes Claude Code discard the decision and the second blocks the tool call. A failed install is not retried for ten minutes.

Three designs were tried before this one and each failed a real run. Running `npx` on every call cost 1.7 seconds a call. With `--prefer-offline` it cost 0.36 seconds, but trusted npm's cached list of versions, so a list cached before a release reported the release as missing. And an entry-point check skipped everything and exited 0 whenever the plugin cache sat behind a symlink, which switched the screens off silently. The launcher has no such check now, and a test starts it through a symlink.

### Putting a client's servers behind the screen (#60, #80)

`agent-chaperone wrap <config>` rewrites every server under `mcpServers` or `servers` to run through the proxy, prints the change, and writes only with `--write`, keeping the original beside the file. A remote entry is wrapped only when the proxy can carry it: a declared `type: "http"` becomes `stdio` and comes back on `--unwrap`, and an entry declaring any other transport, or carrying `headers`, `oauth`, `auth` or `authProviderType`, is skipped with the reason. It reads strict JSON, so a configuration with comments is refused rather than rewritten.

### Release (#12)

`package.json` carries the publishable metadata and no longer says `private`, the README is written for somebody installing the thing rather than reading about it, and the release workflow publishes and nothing else. It used to open a version pull request of its own, which is not how anything here gets written.

### Benchmark

`bench/` holds the harness that evaluated the screening questions against InjecAgent, BIPIA, deepset, a benign "discusses injection" set, and 119 hand-labeled tool calls, with 1,947 recorded responses from `jev-1.13.0` (2026-09-21). The scorer runs from the recorded responses without a key. Headline numbers are in the README; the full report is in `bench/results/report.txt` and `bench/results/analysis.txt`.

## What's In Progress

Nothing in flight. Everything M1 needs is built: MCP traffic and a client's own tools are both screened, every decision is recorded, and a held call can be released.

## What's Next

The package is publishable and the version is 0.1.0. Publishing is a separate, deliberate act: the release workflow runs only when a person starts it and asks for the version to be typed back before it does anything, so merging does not publish.

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
| audit | done (#9, evictions recorded #19) |
| approvals | done (#10) |
| cli | wraps, screens, `log`, `show` and `approve` (#8, #9, #10) |
| hooks | done (#11) |
