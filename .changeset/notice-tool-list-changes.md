---
'agent-chaperone': minor
---

Notice when a server changes the tools it advertises. The first tool list a server sends is recorded as a digest of each tool's description and input schema, and every later list is compared against it, so a rewritten description, a new tool or a removed one is reported. The comparison is local and sends nothing anywhere, and it never withholds the list, because a client that cannot read the tool list cannot call anything. `agent-chaperone trust <server>` accepts a change. `screen_tool_list` turns it off per server, separately from the screens that talk to a model.
