import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const sourceExtensions = ['.ts', '.tsx'];
const runtimeExtensionPattern = /\.(?:[cm]?js|jsx)$/;

function collectSourceFiles(root) {
  const files = [];

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

function hasRuntimeImport(importClause) {
  if (!importClause || importClause.isTypeOnly) {
    return !importClause;
  }

  if (importClause.name) {
    return true;
  }

  const bindings = importClause.namedBindings;
  if (!bindings) {
    return false;
  }

  if (ts.isNamespaceImport(bindings)) {
    return true;
  }

  return (
    bindings.elements.length === 0 ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

function hasRuntimeExport(exportDeclaration) {
  if (exportDeclaration.isTypeOnly) {
    return false;
  }

  if (!exportDeclaration.exportClause) {
    return true;
  }

  if (ts.isNamespaceExport(exportDeclaration.exportClause)) {
    return true;
  }

  return (
    exportDeclaration.exportClause.elements.length === 0 ||
    exportDeclaration.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

function runtimeModuleSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      hasRuntimeImport(node.importClause)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      hasRuntimeExport(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
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

function resolveLocalSourceFile(fromFile, specifier, sourceFiles) {
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

  return candidates.find((candidate) => sourceFiles.has(candidate));
}

function buildGraph(root) {
  const files = collectSourceFiles(root);
  const sourceFiles = new Set(files);
  const graph = new Map(files.map((file) => [file, new Set()]));

  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      false,
    );
    const edges = graph.get(file);

    for (const specifier of runtimeModuleSpecifiers(sourceFile)) {
      const target = resolveLocalSourceFile(file, specifier, sourceFiles);
      if (target) {
        edges.add(target);
      }
    }
  }

  return graph;
}

function findStronglyConnectedComponents(graph) {
  const components = [];
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  let nextIndex = 0;

  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of graph.get(node)) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(neighbor)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) {
      return;
    }

    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component.sort());
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) {
      visit(node);
    }
  }

  return components.filter(
    (component) =>
      component.length > 1 || graph.get(component[0]).has(component[0]),
  );
}

function findConcreteCycle(component, graph) {
  const members = new Set(component);

  for (const from of component) {
    for (const to of graph.get(from)) {
      if (!members.has(to)) {
        continue;
      }
      if (from === to) {
        return [from, from];
      }

      const queue = [[to]];
      const visited = new Set([to]);
      while (queue.length > 0) {
        const currentPath = queue.shift();
        const current = currentPath.at(-1);
        if (current === from) {
          return [from, ...currentPath];
        }
        for (const next of graph.get(current)) {
          if (members.has(next) && !visited.has(next)) {
            visited.add(next);
            queue.push([...currentPath, next]);
          }
        }
      }
    }
  }

  throw new Error('Could not construct a cycle for a strongly connected component.');
}

function displayPath(root, cycle) {
  return cycle.map((file) => path.relative(root, file)).join(' -> ');
}

function main() {
  const root = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'src'));
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Source root is not a directory: ${root}`);
  }

  const graph = buildGraph(root);
  const cycles = findStronglyConnectedComponents(graph);
  if (cycles.length === 0) {
    console.log(`No runtime dependency cycles found under ${root}.`);
    return;
  }

  console.error(`Runtime dependency cycles found under ${root}:`);
  for (const component of cycles) {
    console.error(`  ${displayPath(root, findConcreteCycle(component, graph))}`);
  }
  process.exitCode = 1;
}

main();
