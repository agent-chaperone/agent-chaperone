# Screening a client's own tools

A proxy sees MCP traffic. It does not see the shell, the file edits or the web fetches a client runs itself, and on the clients people actually use those are where most of the damage lives. The hand-labeled benchmark set leans that way on purpose: 44 of the 100 scored calls are shell commands, and 26 of the 51 dangerous ones are.

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
        "matcher": "Bash|PowerShell|Edit|Write|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook pre" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|PowerShell|Read|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook post" }]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash|PowerShell|Read|WebFetch",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook post" }]
      }
    ]
  }
}
```

The matchers are a starting point rather than a recommendation. `PreToolUse` is worth having on anything that changes state or sends data out. `PostToolUse` is worth having on anything that brings text in from somewhere the user did not write, which is where an injected instruction arrives.

`PowerShell` is in both lists because on Windows, wherever that tool is enabled, the client routes shell commands through it and does not register `Bash` at all. A matcher naming only `Bash` screens nothing there, and it fails silently, which is the kind of gap worth spending five characters to close.

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

## Other clients

Cursor documents a comparable hook system, and Codex has not been checked. Each client's contract differs in what a post-tool hook may replace, and that difference decides whether the post-result screen can withhold anything or only annotate it. The entries above are for Claude Code, written against its published hook reference. Adding another client means reading that client's contract rather than assuming this one carries over.
