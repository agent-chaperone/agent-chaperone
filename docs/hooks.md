# Screening a client's own tools

A proxy sees MCP traffic. It does not see the shell, the file edits or the web fetches a client runs itself, and on the clients people actually use those are where most of the damage lives. The hand-labeled benchmark set leans that way on purpose: 37 of the 100 scored calls are shell commands, and 21 of the 51 dangerous ones are.

Two commands cover that gap. They read the client's hook payload on stdin and answer on stdout, using the same policy file, the same deterministic rules, the same questions, the same decision functions and the same audit log as the proxy.

```bash
agent-chaperone hook pre     # before the client runs a tool
agent-chaperone hook post    # after it returns, before the model reads it
```

## Claude Code

Add this to `~/.claude/settings.json` for every project, or to `.claude/settings.json` for one.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Monitor|Edit|Write|NotebookEdit|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook pre" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|PowerShell|Read|Grep|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook post" }]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash|PowerShell|Read|Grep|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook post" }]
      }
    ]
  }
}
```

The same configuration ships as a Claude Code plugin, which registers these three entries and the skill in one step:

```
/plugin marketplace add agent-chaperone/agent-chaperone
/plugin install agent-chaperone@agent-chaperone
```

Its hooks run `scripts/plugin-hook.mjs`. That starts a global `agent-chaperone` when one is on the path. Otherwise, on first use, it installs the version matching the plugin into the directory Claude Code gives the plugin for its own data, with an npm cache of its own there too, and runs that copy directly from then on. The first screened call waits for the install. A failed install is not retried for ten minutes, so the calls after it fail at once rather than each waiting on npm again, and every failure lets the call through rather than blocking it. A test keeps the plugin's matchers identical to the ones above, since a matcher that drifts in one of the two fails silently.

The matchers are a starting point rather than a recommendation. `PreToolUse` is worth having on anything that changes state or sends data out. `PostToolUse` is worth having on anything that brings text in from somewhere the user did not write, which is where an injected instruction arrives.

`PowerShell` is in both lists because on Windows, wherever that tool is enabled, the client routes shell commands through it and does not register `Bash` at all. A matcher naming only `Bash` screens nothing there, and it fails silently, which is the kind of gap worth spending five characters to close.

`Monitor` is in the first list because it runs a command in the background under the same permission rules as Bash, or opens a WebSocket, and its arguments are screened the same way. It is not in the second, because its result is only the id of the background task.

`NotebookEdit` is in the first list because a notebook cell is code that runs later, and a cell like `!rm -rf ~` is a shell command. Claude Code's own permission rules treat it as a file edit.

`Grep` is in the second list because in content mode it returns the matching lines from files, which is the same way an injected instruction reaches the agent through `Read`. It is absent by default on macOS, Linux and WSL, and matters wherever it is present.

A matcher made only of letters and `|` is a list of exact names, so `Edit` does not also match `NotebookEdit`, and each tool has to be named.

`PostToolUseFailure` is a separate event, and without it a failed tool's output is never screened. It fires when a tool threw or an MCP tool returned an error result, and the output arrives as a top-level `error` string instead of in `tool_response`. That text is as attacker-controlled as anything in a result that succeeded: a fetch that fails still returns a body, and a shell command that exits non-zero still prints. The one difference is what can be done about it, which the next section covers.

Screening needs `TYPESAFE_API_KEY` in the environment the client launches hooks in. Without it the deterministic rules still run, which is the allow and deny lists, and every judgment records that no model was asked.

Set `AGENT_CHAPERONE_STORE_CONTENT=0` to keep the judgments and drop the arguments and result text, which is what `--no-store-content` does for the proxy. A hook is launched by the client with a fixed command line, so it takes that choice from the environment rather than from a flag.

The policy file is read from `~/.config/agent-chaperone/policy.yaml`, or from `AGENT_CHAPERONE_POLICY` when that is set. Built-in tools are recorded under the server name `built-in`, so a policy can name them:

```yaml
mode: shadow

servers:
  built-in:
    deny_tools: ['WebFetch']
```

## What the hooks do not see

A hook fires on a tool call, so anything that reaches the model without one is outside this entirely. The clearest case is a file the user references directly in their own message: the client inlines it into the prompt, no tool runs, and no hook fires. Nothing here screens that, and nothing records it. The same goes for anything the client loads at startup, such as its own instruction files.

The lines a `Monitor` reports after it starts are outside it too. They reach the agent as notifications rather than as a tool result, so no hook fires on them, and a log that somebody else can write to is a channel this does not screen.

This is worth knowing before trusting the configuration above to cover file reads. It covers files the agent chose to read. It does not cover files the user handed it.

## What each command answers

`hook pre` returns one of three things.

Nothing at all, when the call is fine. That is not the same as approving it: the client's own permission rules still run, and a screening tool that quietly auto-approved what the user asked to be prompted about would be taking something away rather than adding it.

`permissionDecision: "deny"` with a reason the model reads, when the policy denies the tool outright.

`permissionDecision: "ask"` with a reason, when the call is held. The person is already at the keyboard, so the client is asked to put the question in front of them. The reason still names `agent-chaperone approve <id>`, for a client that shows the text and carries on rather than prompting.

`hook post` returns `updatedToolOutput` when a result is withheld or annotated, and nothing when it passes.

For a failed tool it returns `additionalContext` instead, because that event accepts context and nothing else. So a failed call's output can be annotated and never withheld, and the notice says that rather than implying the content was kept back. This is the client's contract rather than a choice, and it is the reason the post screen is worth having on both events even though only one of them can act.

## The one thing to know about replacing a result

A replacement has to match the tool's own output shape, and a value that does not match is discarded without complaint while the original reaches the model. That failure is silent, which is the one kind this tool cannot have.

So the replacement is built from the shape that arrived rather than from a table of tools. Whatever came in as text goes back as text, the longest run of text carries the notice, the rest is emptied, and everything that described the shape rather than carrying text is returned exactly as it came. A shell result goes back as `{stdout, stderr, interrupted, isImage}` with the notice in `stdout`, which is the shape that tool returns.

Text is not always at the top level, and that part is load-bearing. A file read returns `{type, file: {filePath, content, ...}}`, and an MCP tool returns a bare array of content blocks. Reading only the top level of those finds the word that names the shape, screens it, and reports the result as screened while the payload goes unread. So the whole output is walked, wherever the text sits, and the fields that describe the shape are read but never written into: a notice written over a discriminator produces a value the client discards in favour of the original.

When a result has no text field at all, there is nothing to put a notice in that the client would accept. The command says so in `additionalContext` instead of pretending, and the audit log records that the content could not be withheld.

## Recording what the agent was asked to do

One question the screens can ask is whether a call has anything to do with what the user actually wanted, and it is the only one that needs something no tool call contains. Without a recorded task it is never sent.

`agent-chaperone task` records one, scoped to the working directory:

```
agent-chaperone task "fix the login redirect, nothing outside src/auth"
agent-chaperone task            # read it back
agent-chaperone task --clear
```

The proxy and both hook commands read it when they run. It is believed for twelve hours and then ignored, because a stale task is worse than none: the screen would judge today's calls against intent the user has moved on from, and be confidently wrong rather than silent.

A client that knows what the user asked can record it without anyone typing. On Claude Code, a `UserPromptSubmit` hook receives the prompt on stdin and can hand it straight over:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -r .prompt | xargs -0 agent-chaperone task"
          }
        ]
      }
    ]
  }
}
```

Worth knowing before turning that on. The prompt is sent to the model backend with every screened call afterwards, so this hands over more than a tool call alone would, and `hold_off_task` defaults to `0.9` because a wrong answer here blocks work the user asked for. Read your own log in shadow mode before letting it hold anything.

## Cursor

Add this to `~/.cursor/hooks.json` for every project, or to `.cursor/hooks.json` for one:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "agent-chaperone hook pre",
        "matcher": "^(Shell|WriteShellStdin|Write|Delete|Fetch|WebFetch)$"
      }
    ],
    "postToolUse": [
      { "command": "agent-chaperone hook post", "matcher": "^(Shell|WebFetch|WebSearch)$" }
    ],
    "postToolUseFailure": [
      { "command": "agent-chaperone hook post", "matcher": "^(Shell|WebFetch|WebSearch)$" }
    ]
  }
}
```

The command tells Cursor apart from Claude Code by the payload, and answers in Cursor's shape. That matters because Cursor also runs the hooks in Claude Code's settings files by default, and sends them its own payload. If `~/.claude/settings.json` already carries the entries from the Claude Code section, Cursor runs those too, so register one or the other: with both, every call is screened twice.

What Cursor lets a hook do decides the rest.

A held call is refused rather than asked about. Cursor accepts `ask` from this event and does not act on it, so a hold that asked would run. The refusal names `agent-chaperone approve <id>`, and the call goes through once when the agent tries it again after that.

A result can be annotated and not withheld. Cursor replaces a result only for MCP tools, which the proxy already covers, and for its own tools a hook can only add context next to the result. So a result judged unsafe reaches the model with a note saying it could not be withheld, and `agent-chaperone show <id>` prints what was found.

Some results never reach the hook at all. For `Read`, `Grep`, `Write` and `Delete`, Cursor hands a post-tool hook a summary, such as the file's path and length, rather than the content, so a file the agent reads reaches the model unscreened. `Shell`, `WebFetch` and `WebSearch` carry their content, which is why they are the ones listed. The `cursor-agent` command line does not wait for a post-tool hook on its own tools and ignores what it answers, so there the post side screens and records but cannot annotate.

A hook that crashes, times out or exits with any code but 2 lets the call through, unless the entry sets `"failClosed": true`. The timeout defaults to 60 seconds. Tool names are the ones Cursor 3.7.42 and `cursor-agent` 2026.05.28 send, and MCP tools, which arrive as `MCP:<tool>`, are left to the proxy.

## VS Code

Agent hooks in VS Code are a preview, on by default through `chat.useHooks`. Save this as `~/.copilot/hooks/agent-chaperone.json` for every workspace, or as `.github/hooks/agent-chaperone.json` for one:

```json
{
  "hooks": {
    "PreToolUse": [{ "type": "command", "command": "agent-chaperone hook pre --client vscode" }],
    "PostToolUse": [{ "type": "command", "command": "agent-chaperone hook post --client vscode" }]
  }
}
```

There is no matcher, because VS Code reads one and then ignores it, and runs every hook for every tool. The command applies its own list instead and answers nothing for any other tool:

- before a call: `run_in_terminal`, `send_to_terminal`, `create_and_run_task`, `replace_string_in_file`, `multi_replace_string_in_file`, `insert_edit_into_file`, `create_file`, `apply_patch`, `edit_notebook_file`, `fetch_webpage`, `run_vscode_command`, `install_extension`, `run_playwright_code`, `open_browser_page`, `navigate_page`
- after one: `run_in_terminal`, `send_to_terminal`, `get_terminal_output`, `read_file`, `grep_search`, `fetch_webpage`, `github_repo`, `github_text_search`, `read_page`, `read_notebook_cell_output`, `run_playwright_code`

MCP tools, whose names start with `mcp_`, are left to the proxy.

`--client vscode` says which agent is calling. VS Code sends Claude Code's event and field names, and without the flag it is told apart by the `timestamp` it adds. With `chat.useClaudeHooks` turned on, VS Code also runs the entries in Claude Code's settings files, so register one or the other.

A call is held with `ask`, which puts VS Code's own confirmation in front of the person, and a call that passes gets no decision rather than `allow`, because `allow` skips that confirmation.

A result can be annotated and not withheld. VS Code has no way for a hook to replace a result: a post-tool block appends a note after the original, which the model still reads. So a result judged unsafe arrives with context saying it could not be withheld. In VS Code 1.140.0 that context is added without waiting for it, so it may reach the model after the result rather than with it. VS Code fires no event for a tool that failed, so a failed tool's output is not screened.

A hook that crashes, times out or exits with any code but 2 lets the call through. The timeout defaults to 30 seconds.

## Hermes Agent

Hermes ignores what a shell hook prints after a tool runs, so a result can only be changed from a Python plugin. The plugin in `integrations/hermes/` covers both sides: it hands each call and each result to `agent-chaperone hook pre|post` and does what the command answers.

```bash
cp -R "$(npm root -g)/agent-chaperone/integrations/hermes" ~/.hermes/plugins/agent-chaperone
```

Then enable it in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - agent-chaperone
```

A held call goes to Hermes's own approval prompt. Its "always" answer is remembered under a key for that exact call, so it never allows every later use of the tool. Hermes approves the prompt by itself when `approvals.mode` is `off` or YOLO mode is on, and refuses the call when nobody is there to answer.

A result judged unsafe is withheld: the plugin hands Hermes the replacement in place of the tool's result string. A result that arrives as images and text rather than as a string is left as it came, and is not screened.

It screens these tools, and checks the list before starting anything, so other tools cost nothing:

- before a call: `terminal`, `process_manage`, `write_file`, `patch`, `execute_code`, `web_extract`, `browser_navigate`, `browser_exec`, `browser_cdp`
- after one: `terminal`, `process_manage`, `read_file`, `search_files`, `web_search`, `web_extract`, `execute_code`, `browser_snapshot`, `browser_console`, `browser_exec`

MCP tools, whose names start with `mcp_`, are left to the proxy.

Any failure lets the call through: a missing `agent-chaperone`, a crash, or an answer that does not parse. The plugin waits 25 seconds, under the 30 Hermes allows a plugin before refusing the call itself. This was written against Hermes 0.16.0.

`agent-chaperone wrap ~/.hermes/config.yaml` puts the servers under `mcp_servers` behind the proxy, and keeps the file's comments.

## Other agents

Each agent's contract differs in what a hook can stop before a call and change after it, and that decides whether the post-result screen can withhold anything or only annotate it. The sections above were written against each agent's published contract and its own source at the version named. None has been checked in a live run of the agent yet. Adding another agent means reading its contract rather than assuming one of these carries over.
