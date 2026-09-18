#!/usr/bin/env node
// A minimal stand-in for an MCP server, used by the proxy's integration tests.
// It answers every request, echoing back what it was asked, and understands two
// control methods so tests can exercise failure paths.
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length > 0) handle(line);
    index = buffer.indexOf('\n');
  }
});
// No explicit exit on end of input: the process ends once stdin is finished
// and stdout has drained, so a reply written just before the client left is
// still flushed. Exiting here would discard it.

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write('not json at all\n');
    return;
  }
  if (message.method === 'test/crash') {
    process.exit(3);
  }
  if (message.method === 'test/garbage') {
    process.stdout.write('{ this is not valid json\n');
    return;
  }
  if (message.method === 'test/raw') {
    // Echo the exact bytes received, so a test can prove the relay did not
    // reserialise the message on its way here.
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { raw: line } }) + '\n',
    );
    return;
  }
  if (message.method === 'test/env') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { seen: process.env[message.params.name] ?? null },
      }) + '\n',
    );
    return;
  }
  if (message.id === undefined) {
    return;
  }
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { echoedMethod: message.method, echoedParams: message.params ?? null },
    }) + '\n',
  );
}
