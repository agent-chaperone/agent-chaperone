---
'agent-chaperone': minor
---

`hook pre` and `hook post` now screen the built-in tools of Cursor, VS Code agent mode and Hermes Agent, as well as Claude Code. The agent is read from the payload, or named with `--client`, and each is answered in its own shape. On Cursor a held call is refused with the command that lets it through, and on Cursor and VS Code a result judged unsafe is annotated rather than withheld, because neither lets a hook replace one. Hermes gets a plugin under `integrations/hermes/` that withholds results too. `wrap` also reads Hermes's YAML configuration. Claude Code's answers are unchanged. `docs/hooks.md` has a worked configuration for each agent.
