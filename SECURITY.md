# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in agent-chaperone, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Go to [github.com/agent-chaperone/agent-chaperone/security/advisories/new](https://github.com/agent-chaperone/agent-chaperone/security/advisories/new) and create a private security advisory.
3. Include a description, steps to reproduce, and the potential impact.
4. You will receive an acknowledgment within a few days, and the fix is worked out with you before any public disclosure.

A bypass of a screen (an injection or a dangerous call that scores low) is a model behavior finding rather than a code vulnerability. Report those with the "False Positive or Miss" issue template so the case can become a public test. Use the private channel only when the bypass depends on a bug in the proxy, the rules, or the policy engine.

## Security Considerations

agent-chaperone handles untrusted input on every path: tool arguments, tool results, tool descriptions, resource bodies, policy files, and configuration.

The proxy is not implemented yet, so the list below is the design these paths are built to rather than behavior you can audit in the repository today.

- **Input validation** with Zod at every entry point, with size limits.
- **Safe JSON parsing** inside try/catch with size guards.
- **No dynamic code execution.** No `eval()`, `Function()`, or shell interpolation of content.
- **Secret redaction.** Secret-shaped strings are redacted before anything leaves the machine and before anything is written to the audit log.
- **Content leaves the machine.** Screened arguments and results are sent to the configured model backend. This is stated in the README, and per-server opt-outs exist for content that must stay local.
- **Fail-open by default in shadow mode**, fail-closed on request in strict mode. The mode is explicit in the policy file.
- **No secrets in the repository.** API keys are read from the environment. `.env` files are ignored by git.
- **No personal data in committed artifacts.** Benchmark fixtures are public datasets downloaded at build time or synthetic cases written for this project. Recorded model responses contain probabilities and token counts, not content.
