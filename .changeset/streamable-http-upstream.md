---
'agent-chaperone': minor
---

Screen a Streamable HTTP upstream the same way as a stdio one. A URL in place of a command wraps the server at that URL, with the same policy file, thresholds, audit log and hold flow a local server gets, because the HTTP transport presents itself to the relay as the same pair of streams a child process would. `--header` sends a request header and `--header-env` reads its value from the environment, so a token stays out of the process list. A URL with no `--server` answers to its host in the policy file.
