import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1860 (RT-D1b): Runtime toolRegistry capability boundary', () => {
  it('owner defines ToolRegistryRuntimeCapability with exactly the two consumed operations', () => {
    const types = read('src/foundation/tools/types.ts');
    const registry = read('src/foundation/tools/registry.ts');
    const barrel = read('src/foundation/tools/index.ts');
    const body = types.match(
      /export interface ToolRegistryRuntimeCapability \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(2);
    for (const member of ['getForProfile(', 'formatForLLM(']) {
      expect(body).toContain(member);
    }
    expect(registry).toContain('implements ToolRegistry, ToolRegistryRuntimeCapability');
    expect(barrel).toContain('ToolRegistryRuntimeCapability');
  });

  it('RuntimeDependencies declares the narrow consumer surface', () => {
    const types = read('src/core/runtime/types.ts');

    expect(types).toContain('readonly toolRegistry: ToolRegistryRuntimeCapability;');
    expect(types).not.toContain('readonly toolRegistry: ToolRegistry;');
  });

  it('Runtime private consumption of this.toolRegistry stays within the two capability methods', () => {
    const runtime = read('src/core/runtime/runtime.ts');

    expect(runtime).toContain('protected get toolRegistry(): ToolRegistryRuntimeCapability');
    expect(runtime).toContain('protected get toolRegistryForwarding(): ToolRegistry');
    expect(runtime).not.toContain('protected toolRegistry!: ToolRegistry;');
    const consumed = new Set(
      [...runtime.matchAll(/this\.toolRegistry\.([A-Za-z]+)\s*\(/g)].map((m) => m[1]),
    );

    expect(consumed.size).toBeGreaterThan(0);
    for (const method of consumed) {
      expect(['getForProfile', 'formatForLLM']).toContain(method);
    }
  });

  it('forwarding points consume toolRegistryForwarding (identityToolFilter path preserved)', () => {
    const runtime = read('src/core/runtime/runtime.ts');
    const runtimeTypes = read('src/core/runtime/types.ts');

    expect(runtime).toContain('registry: this.toolRegistryForwarding');
    expect(runtime).toContain('this.options.identityToolFilter(this.toolRegistryForwarding)');
    // identityToolFilter 宽面签名保持原样（phase1860 Step C §5：仅注记、不清理）。
    expect(runtimeTypes).toContain('identityToolFilter?: (registry: ToolRegistry) => void');
  });
});
