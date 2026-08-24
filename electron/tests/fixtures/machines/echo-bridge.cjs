/**
 * NDJSON echo bridge fixture for SSH transport tests (plan unit U7).
 *
 * Stands in for the remote `orchid-agent bridge` behind ssh: reads
 * newline-delimited JSON on stdin and answers each frame on stdout.
 *
 * Modes (argv[2]):
 *   echo         — answer each parsed stdin frame as { echoed: <message> }
 *   chunked      — like echo, but write the answer in two split stdout chunks
 *   silent       — consume stdin, never answer, stay alive
 *   stderr-burst — write argv[3] lines to stderr, then echo
 */
const mode = process.argv[2] ?? 'echo';

if (mode === 'stderr-burst') {
  const count = Number(process.argv[3] ?? '0');
  for (let i = 0; i < count; i += 1) {
    process.stderr.write(`stderr line ${i}\n`);
  }
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (mode === 'silent' || line.trim() === '') return;
  try {
    const message = JSON.parse(line);
    const answer = `${JSON.stringify({ echoed: message })}\n`;
    if (mode === 'chunked') {
      const splitAt = Math.max(1, Math.floor(answer.length / 2));
      process.stdout.write(answer.slice(0, splitAt));
      setTimeout(() => process.stdout.write(answer.slice(splitAt)), 20);
      return;
    }
    process.stdout.write(answer);
  } catch {
    // Malformed frames are dropped; the decoder under test reports them.
  }
});
