import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1367: Runtime inbox rendering resolver boundary', () => {
  it('Messaging owns a one-method read view and the full registry extends it', () => {
    const source = read('src/foundation/messaging/formatter-registry.ts');
    const resolver = source.match(/export interface InboxMessageRenderingResolver \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    const registry = source.match(/export interface InboxMessageTypeRegistry extends InboxMessageRenderingResolver \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(resolver).toBeDefined();
    expect(resolver?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(1);
    expect(resolver).toContain('resolve(type: string): InboxMessageRendering | undefined');
    expect(resolver).not.toContain('register(');

    expect(registry).toBeDefined();
    expect(registry).toContain('register(declaration: InboxMessageTypeDeclaration): void');
    expect(registry).not.toContain('resolve(');
  });

  it('Messaging barrel exports the read view', () => {
    const barrel = read('src/foundation/messaging/index.ts');
    expect(barrel).toMatch(/export type \{[^}]*InboxMessageRenderingResolver[^}]*\} from '.\/formatter-registry\.js';/s);
  });

  it('Runtime propagates only the read view and cannot register declarations', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');

    expect(types).toContain('readonly formatterRegistry: InboxMessageRenderingResolver');
    expect(types).not.toContain('InboxMessageTypeRegistry');
    expect(runtime).toContain('private formatterRegistry!: InboxMessageRenderingResolver');
    expect(runtime).not.toContain('InboxMessageTypeRegistry');
    expect(runtime).not.toContain('formatterRegistry.register(');
  });
});
