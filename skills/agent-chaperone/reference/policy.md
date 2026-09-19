# The policy file

`~/.config/agent-chaperone/policy.yaml`, or wherever `--policy` points. A file that does not exist means the defaults. A file that exists and does not parse stops the proxy from starting, deliberately: enforcing something other than what the user wrote is worse than not running.

Every value below is the default.

```yaml
mode: shadow

thresholds:
  call:
    hold_destructive: 0.70
    hold_exfiltration: 0.60
    hold_policy: 0.70
    hold_off_task: 0.90
  result:
    annotate_instructs: 0.50
    quarantine_instructs: 0.80
    harmful_severity_level: 1.5
    redact_secret: 0.70
  tool_list:
    report_steers: 0.70
  uncertain_severity_confidence: 0.50

servers: {}

redaction:
  patterns:
    [
      aws_key,
      github_token,
      private_key,
      jwt,
      slack_token,
      bearer_token,
      connection_string,
      generic_api_key,
      provider_key,
    ]
```

## Modes

`shadow` screens everything, records every judgment and applies nothing. `enforce` applies what the policy decided. `strict` additionally stops when a screen could not run at all, on the reasoning that an unscreened call is the thing the tool exists to prevent.

The difference between what the policy wanted and what happened is what `agent-chaperone report` counts, and in shadow that is the whole list of things enforcement would change.

## Thresholds

A probability between 0 and 1, except `harmful_severity_level`, which is a position on the four described levels: 0 none, 1 nuisance, 2 harmful, 3 severe.

Call side, first match wins: exfiltration and a secret in the arguments share `hold_exfiltration`, then `hold_destructive`, then `hold_policy`, then `hold_off_task`.

Result side: `quarantine_instructs` is checked before `annotate_instructs`, so an annotate threshold above the quarantine one could never be reached and the file is rejected rather than silently doing nothing.

`hold_off_task` is high on purpose. A wrong answer there blocks work the user asked for, and the question is only sent when a task has been recorded with `agent-chaperone task`.

`report_steers` is not covered by any published measurement. No set in the benchmark asks that question, so this number is a judgement rather than a figure read off a curve.

## Per-server settings

```yaml
servers:
  filesystem:
    deny_tools: [delete_file]
    trust_annotations: true
  github:
    allow_tools: [get_*, list_*, search_*]
  internal-docs:
    screen_results: false
```

- `allow_tools` and `deny_tools` take glob patterns. A deny match blocks; an allow list that exists and does not match blocks. Both are deterministic and need no model.
- `screen_calls` and `screen_results` turn a screen off for one server. Use these for content that must not leave the machine.
- `screen_tool_list` compares the tools a server advertises against the ones it first advertised. It is local, sends nothing and needs no key, which is why it is separate from the two above.
- `screen_tool_descriptions` is **off by default** and sends every new or changed description to the model backend when on.
- `trust_annotations` is off until a user says otherwise, because MCP says a client must treat a server's own tool annotations as untrusted unless the server is trusted.

The server name is whatever `--server` said, or the command's basename, or the host for a URL. `agent-chaperone wrap` sets it to the key in the client's own configuration, so the policy and the client agree.

## Redaction

Which secret shapes are replaced before anything is sent or stored. Narrowing the list means a shape stops being caught, so narrow it only for a pattern that is producing false matches on real content.
