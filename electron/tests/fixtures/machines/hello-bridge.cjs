/**
 * host.hello bridge fixture for connection-manager tests (plan unit U7).
 *
 * Stands in for the remote daemon bridge: answers `host.hello` requests with
 * a matching-id ok response and echoes ok for other request methods.
 *
 * Modes (argv[2]):
 *   stable        — answer every host.hello with the offered protocolVersion
 *   wrong-version — answer host.hello with protocolVersion 999
 *   silent        — consume stdin, never answer, stay alive
 *   die-after     — answer once, then exit(0) ~30ms later
 *   missing       — print `command not found` to stderr and exit(127)
 */
const mode = process.argv[2] ?? 'stable';

if (mode === 'missing') {
  process.stderr.write('bash: orchid-agent: command not found\n');
  process.exit(127);
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (mode === 'silent') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== 'object' || message.id === undefined) return;
  if (message.method === 'host.hello') {
    const offered =
      message.params && message.params.protocolVersion !== undefined
        ? message.params.protocolVersion
        : 1;
    const protocolVersion = mode === 'wrong-version' ? 999 : offered;
    process.stdout.write(
      `${JSON.stringify({ id: message.id, ok: true, result: { protocolVersion, capabilities: [] } })}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result: { ack: true } })}\n`);
  }
  if (mode === 'die-after') {
    setTimeout(() => process.exit(0), 30);
  }
});
