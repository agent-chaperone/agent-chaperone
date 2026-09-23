---
'agent-chaperone': patch
---

`wrap` says what to do with a Gemini CLI server written as `httpUrl`, Gemini CLI's deprecated spelling of a Streamable HTTP server. It was skipped with the reason `it names no command or http url`, which read as if the entry had no URL. It is still skipped, because `--unwrap` could not give back an `httpUrl` it never recorded, and the reason now says to change it to `url` with `"type": "http"`, as Gemini CLI recommends, and run `wrap` again.
