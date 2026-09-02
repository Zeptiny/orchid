#!/usr/bin/env node
/**
 * Bundle the headless `orchid-agent` CLI with esbuild.
 *
 * Modeled on scripts/build-preload.js (platform node, format cjs, node20),
 * with a shebang banner, native modules kept external, and the version
 * injected from package.json so `orchid-agent --version` needs no file I/O.
 *
 * Layout contract (matches the `__dirname`-relative lookups the bundled code
 * performs — see host/daemon.ts callers and the tool/AST worker runners):
 *   dist/agent/orchid-agent.js          agent entry (all host code inlined)
 *   dist/tools/tool-worker.js           tool worker pool entry
 *   dist/agent/get-function-worker.js   dedicated AST get_function worker
 *   dist/agent/defaults/                merged definition defaults (markers
 *                                       disambiguate agents/skills; flat
 *                                       .md files are personalities/prompts)
 *   dist/agent/queries/                 tree-sitter .scm queries
 *
 * The rag/ast index workers are deliberately NOT emitted: both collapse to
 * their inline fallback when the worker file is absent, and the two would
 * collide on dist/agent/index-worker.js inside a single-file bundle.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const NATIVE_EXTERNALS = [
  'electron',
  'better-sqlite3',
  'node-pty',
  'onnxruntime-node',
  '@huggingface/tokenizers',
];

function bundleOnce(entry, outfile, extra = {}) {
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    outfile: path.join(ROOT, outfile),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    external: NATIVE_EXTERNALS,
    ...extra,
  });
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

// 1. Agent entry with shebang + injected version; executable bit set so the
//    `bin` entry works when installed.
bundleOnce('src/main/agent-entry.ts', 'dist/agent/orchid-agent.js', {
  banner: { js: '#!/usr/bin/env node' },
  define: { __AGENT_VERSION__: JSON.stringify(pkg.version) },
});
fs.chmodSync(path.join(ROOT, 'dist/agent/orchid-agent.js'), 0o755);

// 2. Worker entries the bundled host code resolves by conventional path.
bundleOnce('src/main/tools/tool-worker.ts', 'dist/tools/tool-worker.js');
bundleOnce('src/main/tools/ast/get-function-worker.ts', 'dist/agent/get-function-worker.js');

// 3. Non-TS runtime assets (mirrors scripts/copy-defaults.js for the bundle
//    layout above).
copyDir('src/main/agents/defaults', 'dist/agent/defaults');
copyDir('src/main/skills/defaults', 'dist/agent/defaults');
copyDir('src/main/personality/defaults', 'dist/agent/defaults');
copyDir('src/main/prompts/defaults', 'dist/agent/defaults');
copyDir('src/main/ast/queries', 'dist/agent/queries');

console.log('orchid-agent bundled to dist/agent/orchid-agent.js');
