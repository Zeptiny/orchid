#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const NATIVE_MODULES = ['better-sqlite3', 'node-pty', 'onnxruntime-node'];
const PROBE_MARKER = '__ORCHID_NATIVE_PROBE__';
const PROBE_SCRIPT = String.raw`
const modules = JSON.parse(process.env.ORCHID_NATIVE_MODULES);
const failures = [];
for (const moduleName of modules) {
  try {
    if (moduleName === 'better-sqlite3') {
      const Database = require(moduleName);
      const database = new Database(':memory:');
      database.close();
    } else {
      require(moduleName);
    }
  } catch (error) {
    failures.push({
      moduleName,
      detail: error instanceof Error ? error.stack || error.message : String(error),
    });
  }
}
process.stdout.write('${PROBE_MARKER}' + JSON.stringify({
  abi: process.versions.modules,
  failures,
}));
`;

function usage() {
  console.error('Usage: node scripts/ensure-native-runtime.mjs <node|electron> [--force]');
}

function installedNativeModules() {
  return NATIVE_MODULES.filter((moduleName) =>
    fs.existsSync(path.join(PROJECT_DIR, 'node_modules', moduleName)),
  );
}

function probeRuntime(target, modules) {
  const executable = target === 'electron'
    ? require('electron')
    : process.execPath;
  const env = {
    ...process.env,
    ORCHID_NATIVE_MODULES: JSON.stringify(modules),
  };

  if (target === 'electron') {
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }

  const result = spawnSync(executable, ['-e', PROBE_SCRIPT], {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    env,
  });
  const markerIndex = result.stdout?.lastIndexOf(PROBE_MARKER) ?? -1;

  if (result.error || markerIndex === -1) {
    const detail = (result.stderr || result.error?.message || 'native module probe failed').trim();
    return {
      abi: 'unknown',
      failures: modules.map((moduleName) => ({ moduleName, detail })),
    };
  }

  try {
    return JSON.parse(result.stdout.slice(markerIndex + PROBE_MARKER.length));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      abi: 'unknown',
      failures: modules.map((moduleName) => ({ moduleName, detail })),
    };
  }
}

function diagnosticSummary(detail) {
  const lines = detail.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /NODE_MODULE_VERSION|did not self-register|different Node\.js version/i.test(line))
    ?? lines[0]
    ?? 'native module probe failed';
}

async function rebuildForElectron(modules) {
  const electronPackage = JSON.parse(
    fs.readFileSync(path.join(PROJECT_DIR, 'node_modules/electron/package.json'), 'utf8'),
  );
  const { rebuild } = await import('@electron/rebuild');

  console.log(`Rebuilding ${modules.join(', ')} for Electron ${electronPackage.version}...`);
  await rebuild({
    buildPath: PROJECT_DIR,
    electronVersion: electronPackage.version,
    force: true,
    onlyModules: modules,
  });
}

function rebuildForNode(modules) {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const env = { ...process.env };

  delete env.ELECTRON_RUN_AS_NODE;
  delete env.npm_config_disturl;
  delete env.npm_config_runtime;
  delete env.npm_config_target;
  delete env.npm_config_target_arch;

  console.log(`Rebuilding ${modules.join(', ')} for Node ${process.version}...`);
  const result = spawnSync(npmExecutable, ['rebuild', ...modules], {
    cwd: PROJECT_DIR,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm rebuild exited with status ${result.status ?? 'unknown'}`);
  }
}

async function main() {
  const [target, ...flags] = process.argv.slice(2);
  const force = flags.includes('--force');

  if ((target !== 'node' && target !== 'electron') || flags.some((flag) => flag !== '--force')) {
    usage();
    process.exitCode = 2;
    return;
  }

  const modules = installedNativeModules();
  if (modules.length === 0) {
    console.log('No installed native modules to prepare.');
    return;
  }

  const initialProbe = probeRuntime(target, modules);
  if (!force && initialProbe.failures.length === 0) {
    console.log(`Native modules already match ${target} ABI ${initialProbe.abi}.`);
    return;
  }

  for (const failure of initialProbe.failures) {
    console.log(`${failure.moduleName} does not match the ${target} runtime: ${diagnosticSummary(failure.detail)}`);
  }

  const modulesToRebuild = force ? modules : initialProbe.failures.map(({ moduleName }) => moduleName);
  if (target === 'electron') {
    await rebuildForElectron(modulesToRebuild);
  } else {
    rebuildForNode(modulesToRebuild);
  }

  const finalProbe = probeRuntime(target, modules);
  if (finalProbe.failures.length > 0) {
    const details = finalProbe.failures
      .map(({ moduleName, detail }) => `${moduleName}: ${detail}`)
      .join('\n\n');
    throw new Error(`Native module verification failed for ${target}:\n${details}`);
  }

  console.log(`Native modules now match ${target} ABI ${finalProbe.abi}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
