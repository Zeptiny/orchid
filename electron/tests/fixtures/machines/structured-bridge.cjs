/**
 * Structured-seam bridge fixture for SSH frame tests (review fix #18).
 *
 * Stands in for the remote `orchid-agent bridge` behind ssh: answers
 * `host.hello` with the offered protocolVersion and serves one probe method.
 * The method `test.emit` first pushes one event frame (a schema-valid
 * `session:renamed` payload with a per-connection seq) and then responds ok,
 * so a single round-trip exercises request → response → event over the real
 * decoder and the structured seam.
 */
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let seq = 0;

rl.on('line', (line) => {
  if (line.trim() === '') return;
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
    send({ id: message.id, ok: true, result: { protocolVersion: offered, capabilities: [] } });
    return;
  }
  if (message.method === 'test.emit') {
    seq += 1;
    send({ ev: 'session:renamed', params: { id: 'sess-frames', name: 'Emitted' }, seq });
    send({ id: message.id, ok: true, result: { emitted: true } });
    return;
  }
  send({ id: message.id, ok: true, result: { ack: true } });
});
