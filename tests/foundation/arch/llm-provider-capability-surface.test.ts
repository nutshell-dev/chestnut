import { describe, expect, it } from 'vitest';
import {
  FACADES,
  ROOT_FILE,
  ROOT_ERROR_EXPORTS,
  ROOT_TYPE_EXPORTS,
  ROOT_COMPAT_EXPORTS,
  auditProviderSource,
  readBarrelSurface,
  readSource,
  sorted,
  sourceFiles,
} from './llm-provider-capability-surface-helpers.js';
describe('Phase 2173 C6: LLMProvider capability surface', () => {
  it('locks the eight namespace façades and ROOT_COMPAT barrel exports', () => {
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
    expect(result.references.filter(reference => reference.typeOnly)
      .map(reference => reference.name).sort()).toEqual(sorted(ROOT_TYPE_EXPORTS));
    expect(result.references.filter(reference => !reference.typeOnly)
      .map(reference => reference.name).sort()).toEqual(sorted(ROOT_ERROR_EXPORTS));
  });

  it('enforces façade roots, type-only protocol imports, and no deep/omnibus imports in src', () => {
    const violations = sourceFiles().flatMap(file => (
      auditProviderSource(file, readSource(file)).violations
    )).filter(violation =>
      // Legacy preset migration is L4's sole catalog-backed compatibility capability.
      violation !== 'src/core/llm-configuration/preset-migration.ts: llmProviderCatalog is not allowed for core/llm-configuration'
    );
    expect(violations).toEqual([]);
  });

  it('accepts owner-local api-format capability layering without permitting deep imports', () => {
    const result = auditProviderSource(
      'src/foundation/llm-provider/llm-provider-config-schema.ts',
      "import { API_FORMATS } from './api-format.js';",
    );
    expect(result.violations).toEqual([]);
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
