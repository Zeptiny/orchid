import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const sourceExtensions = ['.ts', '.tsx'];
const runtimeExtensionPattern = /\.(?:[cm]?js|jsx)$/;
const electronPackageName = 'electron';

/**
 * Entry points whose reachable static import graph must stay Electron-free
 * (the headless agent host imports exactly this core). Extend as later units
 * relocate more of the runtime (e.g. src/main/host, src/main/machines).
 */
const HOST_CORE_ROOTS = [
  'src/main/llm',
  'src/main/session',
  'src/main/permissions',
  'src/main/config',
  'src/main/project',
  'src/main/mcp',
  'src/main/rag',
  'src/main/ast',
  'src/main/indexing',
  'src/main/agents-md',
  'src/main/defs',
  'src/main/skills',
  'src/main/personality',
  'src/main/prompts',
  'src/main/utils',
  'src/main/logging.ts',
  'src/main/tools',
  'src/main/agents',
];

/**
 * Reachable files explicitly permitted to import the `electron` package.
 * Every entry is a pending extraction (the vault's safeStorage default is
 * replaced by a plain-Node adapter in a later unit); keep this list short.
 */
const ELECTRON_IMPORT_ALLOWLIST = new Set([
  'src/main/providers/credentials/vault.ts',
]);

function collectSourceFiles(root) {
  const files = [];

  if (fs.statSync(root).isFile()) {
    return [root];
  }

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (
        entry.isFile() &&
        sourceExtensions.includes(path.extname(entry.name)) &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(entryPath);
      }
    }
  }

  visit(root);
  return files.sort();
}

function moduleSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      node.argument &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      (
        (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveLocalSourceFile(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return undefined;
  }

  const unresolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];
  const extension = path.extname(unresolved);

  if (sourceExtensions.includes(extension)) {
    candidates.push(unresolved);
  } else if (runtimeExtensionPattern.test(unresolved)) {
    const extensionless = unresolved.slice(0, -extension.length);
    for (const sourceExtension of sourceExtensions) {
      candidates.push(`${extensionless}${sourceExtension}`);
    }
  } else if (!extension) {
    for (const sourceExtension of sourceExtensions) {
      candidates.push(`${unresolved}${sourceExtension}`);
      candidates.push(path.join(unresolved, `index${sourceExtension}`));
    }
  }

  return candidates.find(
    (candidate) =>
      !candidate.endsWith('.d.ts') &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile(),
  );
}

function displayPath(appRoot, file) {
  const relative = path.relative(appRoot, file);
  return relative.startsWith('..') ? file : relative.replaceAll(path.sep, '/');
}

function findElectronImports(rootFiles, appRoot) {
  const violations = [];
  const visited = new Set();
  const queue = [...rootFiles];

  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      false,
    );

    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (specifier === electronPackageName) {
        const relative = path.relative(appRoot, file).replaceAll(path.sep, '/');
        if (!ELECTRON_IMPORT_ALLOWLIST.has(relative)) {
          violations.push({ file: displayPath(appRoot, file), specifier });
        }
        continue;
      }
      const target = resolveLocalSourceFile(file, specifier);
      if (target) queue.push(target);
    }
  }

  return violations;
}

function main() {
  const appRoot = path.resolve(import.meta.dirname, '..');
  const args = process.argv.slice(2);
  const roots = (args.length > 0 ? args : HOST_CORE_ROOTS).map((root) =>
    path.resolve(root),
  );

  const rootFiles = roots.flatMap((root) => {
    if (!fs.existsSync(root)) {
      throw new Error(`Source root does not exist: ${root}`);
    }
    return collectSourceFiles(root);
  });

  const violations = findElectronImports(rootFiles, appRoot);
  if (violations.length === 0) {
    console.log(`No electron imports reachable from the host-core roots under ${appRoot}.`);
    return;
  }

  console.error(`Host-core modules reachable from the roots import the electron package:`);
  for (const violation of [...new Set(violations)]) {
    console.error(`  ${violation.file} imports '${violation.specifier}'`);
  }
  process.exitCode = 1;
}

main();
