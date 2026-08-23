/**
 * Opt-in smoke for the bundled `orchid-agent` daemon (U4).
 *
 * Runs the real CLI artifact, not the test mocks:
 *   1. `orchid-agent --version` prints the package version.
 *   2. `orchid-agent serve --stdio` completes a `host.hello` handshake and
 *      answers a real `session.list` against this machine's ~/.orchid.
 *
 * Gating: the bundle is a build artifact (`npm run build:agent`), so the
 * smoke skips gracefully when it is absent unless ORCHID_AGENT_SMOKE=1 is
 * set — then a missing bundle is a failure.
 *
 *   npm run build:agent && ORCHID_AGENT_SMOKE=1 npm run test:agent:smoke
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Node runs this standalone smoke script as CommonJS. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const AGENT_BIN = path.resolve(__dirname, '..', '..', 'dist', 'agent', 'orchid-agent.js');
const REQUEST_TIMEOUT_MS = 30_000;
const FORCED = process.env.ORCHID_AGENT_SMOKE === '1';

class SmokeFailure extends Error {}

function requireBundle(): void {
  if (fs.existsSync(AGENT_BIN)) return;
  if (FORCED) {
    throw new SmokeFailure(
      `Agent bundle missing at ${AGENT_BIN}. Run \`npm run build:agent\` first.`,
    );
  }
  console.log(`[agent-smoke] skipped: bundle missing at ${AGENT_BIN} (run \`npm run build:agent\`, then ORCHID_AGENT_SMOKE=1)`);
}

function runAgent(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT_BIN, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SmokeFailure(`orchid-agent ${args.join(' ')} timed out`));
    }, REQUEST_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end();
  });
}

/** One framed stdio round trip: send requests, collect every response. */
function serveStdioRoundTrip(): Promise<Array<{ id: number; ok: boolean; result?: unknown; error?: unknown }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT_BIN, 'serve', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const frames: Array<{ id: number; ok: boolean }> = [];
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SmokeFailure(`serve --stdio did not answer within ${REQUEST_TIMEOUT_MS}ms; stderr: ${stderr}`));
    }, REQUEST_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          frames.push(JSON.parse(line));
          if (frames.length === 2) {
            clearTimeout(timer);
            child.stdin.end();
            resolve(frames);
          }
        }
        index = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'host.hello', params: { protocolVersion: 1 } })}\n`);
    child.stdin.write(`${JSON.stringify({ id: 2, method: 'session.list', params: {} })}\n`);
  });
}

async function main(): Promise<void> {
  requireBundle();

  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
  );

  const versionRun = await runAgent(['--version']);
  if (versionRun.code !== 0 || versionRun.stdout.trim() !== pkg.version) {
    throw new SmokeFailure(
      `--version printed '${versionRun.stdout.trim()}' (exit ${versionRun.code}); expected '${pkg.version}'`,
    );
  }

  const responses = await serveStdioRoundTrip();
  const hello = responses.find((frame) => frame.id === 1);
  if (!hello || hello.ok !== true) {
    throw new SmokeFailure(`host.hello failed: ${JSON.stringify(hello)}`);
  }
  const result = hello.result as { protocolVersion?: number; capabilities?: string[] };
  if (result.protocolVersion !== 1) {
    throw new SmokeFailure(`unexpected protocol version: ${result.protocolVersion}`);
  }
  if (!Array.isArray(result.capabilities) || result.capabilities.length === 0) {
    throw new SmokeFailure('handshake advertised no capabilities');
  }
  const list = responses.find((frame) => frame.id === 2);
  if (!list || list.ok !== true) {
    throw new SmokeFailure(`session.list failed: ${JSON.stringify(list)}`);
  }

  console.log(
    `[agent-smoke] ok — version ${pkg.version}, handshake capabilities [${result.capabilities.join(', ')}], ` +
      `${(list.result as unknown[]).length} session(s) visible`,
  );
}

main().catch((error) => {
  if (error instanceof SmokeFailure) {
    console.error(`[agent-smoke] FAILED: ${error.message}`);
  } else {
    console.error('[agent-smoke] FAILED:', error);
  }
  process.exit(1);
});
