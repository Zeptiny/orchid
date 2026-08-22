/**
 * Copy non-TS runtime assets into dist/ after tsc.
 *
 * tsc only emits .js from .ts sources; markdown defaults, tree-sitter
 * query files, and similar assets must be copied explicitly.
 */
const fs = require('fs');
const path = require('path');

const pairs = [
  ['src/main/agents/defaults', 'dist/main/agents/defaults'],
  ['src/main/skills/defaults', 'dist/main/skills/defaults'],
  ['src/main/personality/defaults', 'dist/main/personality/defaults'],
  ['src/main/prompts/defaults', 'dist/main/prompts/defaults'],
  // AST tree-sitter queries (.scm) — required by parser.loadQueryFile()
  ['src/main/ast/queries', 'dist/main/ast/queries'],
];

for (const [src, dst] of pairs) {
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
