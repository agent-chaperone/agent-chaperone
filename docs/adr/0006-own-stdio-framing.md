# ADR-0006: Own the stdio framing rather than using the MCP SDK's transports

## Status

Accepted

## Context

The proxy speaks the Model Context Protocol on both sides, and the official SDK ships stdio transports for exactly this: `StdioServerTransport` for the side facing the client, `StdioClientTransport` for the side facing the upstream server. Using them would have been the obvious choice and would have meant less code.

They cannot be used, because they validate. The SDK's framing parses every line with `JSONRPCMessageSchema`, and `JSONRPCRequestSchema` is declared strict. A request carrying an unknown top-level field is rejected outright rather than passed along. Measured against the installed SDK, a request with an extra top-level key throws, while the same shape nested inside `params` survives, because the params schema is loose.

That behavior is right for a peer and wrong for a proxy. A proxy that refuses messages it does not recognise breaks any protocol extension, and one that silently reserialises what it relays can add or remove content without anyone noticing. Neither is acceptable for a tool whose whole claim is that it sees what actually crossed the wire.

## Decision

The package does its own newline framing. A line is read, the exact text is kept, and that exact text is what gets written to the other side. The line is parsed only on a copy, and only far enough to classify it and pair a response with the request that produced it. Anything that fails to parse still relays untouched.

Two consequences follow, and both are deliberate:

- No message is ever validated, normalised or rewritten in transit. Key order, spacing and unknown fields survive.
- Framing owns its own size limit, matching the SDK's default so the proxy is never the first to refuse a large message.

The SDK remains a dependency for its types and for the parts of the system that act as a genuine peer rather than a relay.

## Consequences

- Protocol extensions, vendor fields and future revisions pass through without a change here.
- The framing is ours to get right, including the size bound and the cost of assembling a line from many chunks. Both are covered by tests.
- If the SDK later offers a transport that relays without validating, this decision is worth revisiting, and the seam is small.
