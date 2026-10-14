# Screening a client's own tools

A proxy sees MCP traffic. It does not see the shell commands, file edits or web fetches a client runs itself, and on the clients people actually use those are where most of the damage lives. Two commands read a client's hook payload on stdin and answer on stdout, against the same policy file and the same log.

## Configuration

For Claude Code, in the settings file:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook pre" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Read|WebFetch|WebSearch|Grep|Glob",
        "hooks": [{ "type": "command", "command": "agent-chaperone hook post" }]
      }
    ]
  }
}
```

The pre matcher covers the tools that do something. The post matcher covers the tools that bring text back, which is where injected instructions arrive.

## What each command answers

`hook pre` answers `permissionDecision: "deny"` with the reason when a call is blocked, and `"ask"` when it is held. The process exits 0 in both cases, so exit status says nothing about the decision.

`hook post` answers `updatedToolOutput` when a result is withheld or annotated, and nothing at all when it passes.

For a failed tool the client sends `PostToolUseFailure`, which accepts `additionalContext` and nothing else. So a failed call's output can be annotated and never withheld, and the notice says that rather than implying the content was held back.

## Recording the task

One screening question asks whether a call has anything to do with what the user actually wanted, and it is the only question that needs something no tool call contains.

```bash
agent-chaperone task "fix the login redirect, nothing outside src/auth"
agent-chaperone task            # read it back
agent-chaperone task --clear
```

Scoped to the working directory and believed for twelve hours, because a stale task would have the screen judging today's calls against intent the user has moved on from.

A client that already knows the prompt can record it automatically through a `UserPromptSubmit` hook. Two things to say before anyone turns that on: the prompt then reaches the model backend with every screened call afterwards, and `hold_off_task` defaults to 0.9 precisely because a wrong answer there blocks work the user asked for.

## What hooks cannot do

A replacement has to match the tool's own output shape, and a value that does not match is discarded silently while the original reaches the model. So the replacement is built from the shape that arrived rather than from a table of tools, and when a result has no text field at all there is nothing to put a notice in that the client would accept. The command says so in `additionalContext` instead of pretending, and the log records that the content could not be withheld.

Stderr from a hook that exits 0 reaches the debug log and nowhere else, so exiting 0 with empty stdout means "no decision" and is never a safe way to report a problem.

## Other clients

The entries above are for Claude Code. The same two commands also answer Cursor, VS Code agent mode and Hermes Agent, each in its own shape, and read which one is calling from the payload; `--client cursor|vscode|hermes|claude` names it instead. The configuration for each is in the repository's `docs/hooks.md`. What differs is what each agent lets a hook do:

- Cursor does not act on `ask` before a call, so a hold is refused with `permission: "deny"`, and the reason names `agent-chaperone approve <id>`. Its own tools' results cannot be replaced, so one judged unsafe is annotated through `additional_context`, and `Read` and `Grep` results reach the hook only as a summary and are not screened.
- VS Code answers like Claude Code before a call. After one it cannot replace a result, so one judged unsafe gets `additionalContext` saying it could not be withheld. It ignores matchers, so the command screens its own list of tools.
- Hermes Agent runs the plugin in `integrations/hermes/`, which holds a call through Hermes's approval prompt and replaces a result judged unsafe.
