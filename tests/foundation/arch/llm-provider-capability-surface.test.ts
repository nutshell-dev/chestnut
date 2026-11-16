/**
 * Phase 2173 C6: LLMProvider capability façade architecture guard.
 *
 * Deliberately uses createSourceFile only: this is a syntax/consumer audit, not
 * a whole-repository TypeScript compilation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const BARREL_FILE = 'src/foundation/llm-provider/index.ts';
const ROOT_FILE = 'src/index.ts';
const PROVIDER_PREFIX = 'src/foundation/llm-provider';

const FACADES = {
  llmProviderCall: {
    module: './capabilities/call.js',
    roots: [
      'foundation/llm-orchestrator',
      'core/step-executor',
      'core/runtime',
      'core/contract',
      'core/memory',
    ],
  },
  llmProviderProtocol: {
    module: './capabilities/protocol.js',
    roots: [
      'foundation/dialog-store',
      'foundation/tool-protocol',
      'foundation/tools',
      'foundation/file-tool',
      'foundation/llm-orchestrator',
      'core',
      'templates',
      'cli',
    ],
  },
  llmProviderModelMeasurement: {
    module: './capabilities/model-measurement.js',
    roots: [
      'core/context_manager',
      'core/runtime',
      'core/memory',
      'foundation/llm-orchestrator',
      'assembly',
    ],
  },
  llmProviderConfigContract: {
    module: './capabilities/config-contract.js',
    roots: [
      'core/llm-configuration',
      'core/runtime',
      'foundation/llm-orchestrator',
      'cli',
    ],
  },
  llmProviderCatalog: {
    module: './capabilities/catalog.js',
    roots: ['cli', 'assembly'],
  },
  llmProviderCredentialRuntime: {
    module: './capabilities/credential-runtime.js',
    roots: ['core/llm-configuration', 'cli'],
  },
  llmProviderAbort: {
    module: './capabilities/abort.js',
    roots: [
      'foundation/llm-orchestrator',
      'core/subagent',
      'core/claw-topology',
      'core/summon-system',
      'assembly',
    ],
  },
} as const;

type FacadeName = keyof typeof FACADES;

const ROOT_ERROR_EXPORTS = [
  'LLMError',
  'LLMAuthError',
  'LLMEmptyResponseError',
  'LLMModelNotFoundError',
  'LLMNetworkError',
  'LLMRateLimitError',
  'LLMQuotaError',
  'LLMTimeoutError',
] as const;
const ROOT_TYPE_EXPORTS = [
  'TextBlock',
  'ToolUseBlock',
  'ToolResultBlock',
  'ThinkingBlock',
  'ContentBlock',
  'ToolDefinition',
  'JSONSchema7',
  'LLMResponse',
  'ProviderConfig',
] as const;
const ROOT_COMPAT_EXPORTS = [...ROOT_ERROR_EXPORTS, ...ROOT_TYPE_EXPORTS] as const;

interface ProviderReference {
  kind: 'import' | 'export';
  name: string;
  localName: string;
  typeOnly: boolean;
}

interface AuditResult {
  violations: string[];
  references: ProviderReference[];
}

const isFacade = (name: string): name is FacadeName => name in FACADES;
const sorted = (names: readonly string[]): string[] => [...names].sort();

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function providerTarget(file: string, specifier: string): 'barrel' | 'deep' | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const withoutExtension = resolved.replace(/\.(?:js|ts)$/, '');
  if (withoutExtension === `${PROVIDER_PREFIX}/index`) return 'barrel';
  if (
    withoutExtension === PROVIDER_PREFIX
    || withoutExtension.startsWith(`${PROVIDER_PREFIX}/`)
  ) return 'deep';
  return null;
}

function consumerRoot(file: string): string {
  const [top, second] = file.slice('src/'.length).split('/');
  return top === 'core' || top === 'foundation' ? `${top}/${second}` : top;
}

function facadeAllowed(file: string, facade: FacadeName): boolean {
  const root = consumerRoot(file);
  return FACADES[facade].roots.some(
    allowed => root === allowed || root.startsWith(`${allowed}/`),
  );
}

function usesMakeToolUseId(source: ts.SourceFile, localName: string): boolean {
  let used = false;
  const visit = (node: ts.Node): void => {
    if (used) return;
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === localName
      && node.name.text === 'makeToolUseId'
    ) {
      used = true;
      return;
    }
    if (
      ts.isElementAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === localName
      && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === 'makeToolUseId'
    ) {
      used = true;
      return;
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && ts.isIdentifier(node.initializer)
      && node.initializer.text === localName
    ) {
      used = node.name.elements.some(element => {
        const property = element.propertyName ?? element.name;
        return ts.isIdentifier(property) && property.text === 'makeToolUseId';
      });
      if (used) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return used;
}

/** Parse only named imports/re-exports that resolve to the provider owner. */
function auditProviderSource(file: string, text: string): AuditResult {
  const result: AuditResult = { violations: [], references: [] };
  // The owner implementation may naturally import its own internal modules.
  if (file.startsWith(`${PROVIDER_PREFIX}/`)) return result;

  const source = parse(file, text);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    const target = providerTarget(file, specifier);
    if (!target) continue;
    if (target === 'deep') {
      result.violations.push(`${file}: deep import/export ${specifier}`);
      continue;
    }

    const kind = ts.isImportDeclaration(statement) ? 'import' : 'export';
    const clause = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : statement.exportClause;
    if (!clause || (!ts.isNamedImports(clause) && !ts.isNamedExports(clause))) continue;
    const declarationTypeOnly = ts.isImportDeclaration(statement)
      ? statement.importClause?.isTypeOnly ?? false
      : statement.isTypeOnly;

    for (const element of clause.elements) {
      const name = (element.propertyName ?? element.name).text;
      const reference: ProviderReference = {
        kind,
        name,
        localName: element.name.text,
        typeOnly: declarationTypeOnly || element.isTypeOnly,
      };
      result.references.push(reference);

      if (file === ROOT_FILE) {
        if (kind !== 'export' || !(ROOT_COMPAT_EXPORTS as readonly string[]).includes(name)) {
          result.violations.push(`${file}: non-compat named ${kind} ${name}`);
        }
        continue;
      }
      if (!isFacade(name)) {
        result.violations.push(`${file}: legacy omnibus named ${kind} ${name}`);
        continue;
      }
      if (!facadeAllowed(file, name)) {
        result.violations.push(
          `${file}: ${name} is not allowed for ${consumerRoot(file)}`,
        );
        continue;
      }
      if (
        name === 'llmProviderProtocol'
        && kind === 'import'
        && !reference.typeOnly
        && !usesMakeToolUseId(source, reference.localName)
      ) {
        result.violations.push(
          `${file}: llmProviderProtocol value import does not use makeToolUseId`,
        );
      }
    }
  }
  return result;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const scan = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(absolute);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(absolute);
    }
  };
  scan(path.resolve(process.cwd(), 'src'));
  return files
    .map(file => `src/${path.relative(path.resolve(process.cwd(), 'src'), file)}`)
    .map(file => file.split(path.sep).join(path.posix.sep))
    .sort();
}

function readSource(file: string): string {
  return readFileSync(path.resolve(process.cwd(), file), 'utf8');
}

function readBarrelSurface(): {
  namespaces: Record<string, string>;
  values: string[];
  types: string[];
} {
  const source = parse(BARREL_FILE, readSource(BARREL_FILE));
  const namespaces: Record<string, string> = {};
  const values: string[] = [];
  const types: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (ts.isNamespaceExport(statement.exportClause)) {
      namespaces[statement.exportClause.name.text] = statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : '';
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const target = statement.isTypeOnly || element.isTypeOnly ? types : values;
      target.push(element.name.text);
    }
  }
  return { namespaces, values: values.sort(), types: types.sort() };
}

describe('Phase 2173 C6: LLMProvider capability surface', () => {
  it('locks the seven namespace façades and ROOT_COMPAT barrel exports', () => {
    const surface = readBarrelSurface();
    expect(surface.namespaces).toEqual(Object.fromEntries(
      Object.entries(FACADES).map(([name, facade]) => [name, facade.module]),
    ));
    expect(surface.values).toEqual(sorted(ROOT_ERROR_EXPORTS));
    expect(surface.types).toEqual(sorted(ROOT_TYPE_EXPORTS));
  });

  it('keeps runtime keys limited to façades and ROOT_COMPAT error values', async () => {
    const provider = await import('../../../src/foundation/llm-provider/index.js');
    expect(Object.keys(provider).sort()).toEqual(
      sorted([...Object.keys(FACADES), ...ROOT_ERROR_EXPORTS]),
    );
  });

  it('allows only the exact compat named re-exports from the package root', () => {
    const result = auditProviderSource(ROOT_FILE, readSource(ROOT_FILE));
    expect(result.violations).toEqual([]);
    expect(result.references.map(reference => reference.name).sort()).toEqual(
      sorted(ROOT_COMPAT_EXPORTS),
    );
    expect(result.references.every(reference => reference.kind === 'export')).toBe(true);
    expect(result.references.filter(reference => reference.typeOnly).map(
      reference => reference.name,
    ).sort()).toEqual(sorted(ROOT_TYPE_EXPORTS));
    expect(result.references.filter(reference => !reference.typeOnly).map(
      reference => reference.name,
    ).sort()).toEqual(sorted(ROOT_ERROR_EXPORTS));
  });

  it('enforces façade roots, type-only protocol imports, and no deep/omnibus imports in src', () => {
    const violations = sourceFiles().flatMap(file => (
      auditProviderSource(file, readSource(file)).violations
    ));
    expect(violations).toEqual([]);
  });

  it('rejects inline negative fixtures for every boundary failure mode', () => {
    const fixtures = [
      {
        name: 'LLMConfiguration cannot consume catalog',
        file: 'src/core/llm-configuration/fixture.ts',
        source: "import { llmProviderCatalog } from '../../foundation/llm-provider/index.js';",
        expected: 'llmProviderCatalog is not allowed for core/llm-configuration',
      },
      {
        name: 'ContextManager cannot consume credential runtime',
        file: 'src/core/context_manager/fixture.ts',
        source: "import { llmProviderCredentialRuntime } from '../../foundation/llm-provider/index.js';",
        expected: 'llmProviderCredentialRuntime is not allowed for core/context_manager',
      },
      {
        name: 'protocol value import requires actual makeToolUseId use',
        file: 'src/foundation/dialog-store/fixture.ts',
        source: "import { llmProviderProtocol } from '../llm-provider/index.js';",
        expected: 'llmProviderProtocol value import does not use makeToolUseId',
      },
      {
        name: 'legacy createLLMProvider named import is forbidden',
        file: 'src/foundation/dialog-store/fixture.ts',
        source: "import { createLLMProvider } from '../llm-provider/index.js';",
        expected: 'legacy omnibus named import createLLMProvider',
      },
      {
        name: 'deep provider imports are forbidden even for types',
        file: 'src/core/runtime/fixture.ts',
        source: "import type { LLMProvider } from '../../foundation/llm-provider/types.js';",
        expected: 'deep import/export ../../foundation/llm-provider/types.js',
      },
      {
        name: 'an alias cannot bypass the façade allowlist',
        file: 'src/core/llm-configuration/fixture.ts',
        source: "import { llmProviderCatalog as catalog } from '../../foundation/llm-provider/index.js';",
        expected: 'llmProviderCatalog is not allowed for core/llm-configuration',
      },
      {
        name: 'an alias cannot bypass the legacy named-import ban',
        file: 'src/foundation/dialog-store/fixture.ts',
        source: "import { createLLMProvider as makeProvider } from '../llm-provider/index.js';",
        expected: 'legacy omnibus named import createLLMProvider',
      },
    ];

    for (const fixture of fixtures) {
      const result = auditProviderSource(fixture.file, fixture.source);
      expect(result.violations, fixture.name).toHaveLength(1);
      expect(result.violations[0], fixture.name).toContain(fixture.expected);
    }
  });

  it('distinguishes mixed inline type imports from value imports', () => {
    const result = auditProviderSource(
      'src/core/step-executor/fixture.ts',
      `import {
        llmProviderCall,
        type llmProviderProtocol as Protocol,
      } from '../../foundation/llm-provider/index.js';`,
    );
    expect(result.violations).toEqual([]);
    expect(result.references).toEqual([
      {
        kind: 'import',
        name: 'llmProviderCall',
        localName: 'llmProviderCall',
        typeOnly: false,
      },
      {
        kind: 'import',
        name: 'llmProviderProtocol',
        localName: 'Protocol',
        typeOnly: true,
      },
    ]);
  });

  it('accepts an aliased protocol value import only when makeToolUseId is used', () => {
    const result = auditProviderSource(
      'src/foundation/dialog-store/fixture.ts',
      `import { llmProviderProtocol as protocol } from '../llm-provider/index.js';
       const { makeToolUseId: makeId } = protocol;
       makeId('tool-call');`,
    );
    expect(result.violations).toEqual([]);
  });
});
