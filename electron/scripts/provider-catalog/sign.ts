/**
 * Produce a detached Ed25519 base64 signature for exact catalog bytes.
 * The private key path is operator-supplied and is never copied into the app.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey, sign } = require('node:crypto');

function getOption(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const input = getOption('--input');
  const privateKeyPath = getOption('--private-key');
  if (!input || !privateKeyPath) {
    throw new Error('Usage: --input <catalog.json> --private-key <ed25519-private-key.pem> [--output <catalog.json.sig>]');
  }
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(getOption('--output') ?? `${inputPath}.sig`);
  const bytes = fs.readFileSync(inputPath);
  const privateKey = createPrivateKey(fs.readFileSync(path.resolve(privateKeyPath)));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Catalog signing key must be Ed25519');
  }
  const signature = sign(null, bytes, privateKey).toString('base64');
  fs.writeFileSync(outputPath, `${signature}\n`, { mode: 0o600 });
  fs.chmodSync(outputPath, 0o600);
  console.log(`Wrote detached Ed25519 signature to ${outputPath}`);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
