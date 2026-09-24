import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0005's boundary, as a source guard: `@mastra/core` is imported only under `src/mastra/`.
 * The compiler, the kernel, verification, the codec and the conformance harness stay host-free, so
 * they may not reach Mastra through `src/mastra/` either — only the package root re-exports it.
 *
 * Imports are read from the TypeScript AST, not with a regex, so every form counts: static and
 * side-effect imports, `import type`, re-exports, `import x = require()`, dynamic `import()`,
 * `require()`, type-level `import('…')`, and `/// <reference types>`. Comments and strings do not.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const HOST_DIR = join(SRC, 'mastra');
/** The package root re-exports the Mastra entry (`src/index.ts`); nothing else outside may. */
const MAY_REEXPORT_HOST = new Set([join(SRC, 'index.ts')]);

interface ModuleReference {
  readonly specifier: string;
  readonly kind: string;
  readonly line: number;
}

/** Every module a source file references, in any syntactic form. */
function moduleReferences(fileName: string, text: string): ModuleReference[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ModuleReference[] = [];
  const add = (node: ts.Node, specifier: ts.Expression | undefined, kind: string) => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      found.push({ specifier: specifier.text, kind, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, node.importClause?.isTypeOnly ? 'import type' : 'import');
    else if (ts.isExportDeclaration(node)) add(node, node.moduleSpecifier, node.isTypeOnly ? 'export type from' : 'export from');
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, 'import = require');
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], 'dynamic import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node, node.arguments[0], 'require');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal as ts.Expression, 'import type()');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const ref of [...source.typeReferenceDirectives, ...source.referencedFiles]) {
    found.push({ specifier: ref.fileName, kind: '/// <reference>', line: source.getLineAndCharacterOfPosition(ref.pos).line + 1 });
  }
  return found;
}

const isMastraPackage = (specifier: string) => specifier === '@mastra' || specifier.startsWith('@mastra/');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(c|m)?tsx?$/.test(entry.name) ? [path] : [];
  });
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** A relative specifier's target, extension-agnostic (`./x.js` is `./x.ts`). */
const target = (from: string, specifier: string) => resolve(dirname(from), specifier).replace(/\.(c|m)?(j|t)sx?$/, '');

describe('the Mastra runtime boundary (ADR 0005)', () => {
  const files = sourceFiles(SRC);
  const outside = files.filter((f) => !within(f, HOST_DIR));
  const inside = files.filter((f) => within(f, HOST_DIR));

  it('scans a real tree on both sides of the boundary', () => {
    expect(outside.length).toBeGreaterThanOrEqual(10);
    expect(inside.length).toBeGreaterThanOrEqual(5);
    // Positive control: the guard sees the host imports that do exist.
    const hostImports = inside.flatMap((f) => moduleReferences(f, readFileSync(f, 'utf8'))).filter((r) => isMastraPackage(r.specifier));
    expect(hostImports.length).toBeGreaterThan(0);
  });

  it('no file outside src/mastra/ imports @mastra/*, in any form', () => {
    const violations = outside.flatMap((f) =>
      moduleReferences(f, readFileSync(f, 'utf8'))
        .filter((r) => isMastraPackage(r.specifier))
        .map((r) => `${relative(SRC, f)}:${r.line} ${r.kind} '${r.specifier}'`),
    );
    expect(violations).toEqual([]);
  });

  it('no host-free file reaches Mastra through src/mastra/ — only the package root re-exports it', () => {
    const violations = outside
      .filter((f) => !MAY_REEXPORT_HOST.has(f))
      .flatMap((f) =>
        moduleReferences(f, readFileSync(f, 'utf8'))
          .filter((r) => r.specifier.startsWith('.') && within(target(f, r.specifier), HOST_DIR))
          .map((r) => `${relative(SRC, f)}:${r.line} ${r.kind} '${r.specifier}'`),
      );
    expect(violations).toEqual([]);
  });

  it('the guard itself catches every import form, and ignores comments and strings', () => {
    const text = [
      // A triple-slash directive counts only before the first statement.
      '/// <reference types="@mastra/core" />',
      "import { a } from '@mastra/core/workflows';",
      "import type { B } from '@mastra/core/di';",
      "import '@mastra/core';",
      "export { c } from '@mastra/core/agent';",
      "export type { D } from '@mastra/core/tools';",
      "export * from '@mastra/core/mastra';",
      "import e = require('@mastra/core/evals');",
      "const f = await import('@mastra/core/storage');",
      "const g = require('@mastra/core/logger');",
      "type H = import('@mastra/core/workflows').Step;",
      "type I = typeof import('@mastra/core/workflows/evented');",
      "// import { x } from '@mastra/core';",
      "const s = \"import { y } from '@mastra/core'\";",
      "import { z } from '../mastra/engine.js';",
    ].join('\n');
    const refs = moduleReferences('probe.ts', text);
    expect(refs.filter((r) => isMastraPackage(r.specifier)).map((r) => r.kind).sort()).toEqual(
      [
        '/// <reference>',
        'dynamic import',
        'export from',
        'export from',
        'export type from',
        'import',
        'import',
        'import = require',
        'import type',
        'import type()',
        'import type()',
        'require',
      ].sort(),
    );
    const probe = join(SRC, 'compiler', 'probe.ts');
    expect(refs.filter((r) => r.specifier.startsWith('.') && within(target(probe, r.specifier), HOST_DIR))).toHaveLength(1);
  });
});
