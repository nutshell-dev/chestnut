import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1361: skill context source boundary', () => {
  it('owner capability contains exactly load and context formatting', () => {
    const source = read('src/foundation/skill-system/registry.ts');
    const body = source.match(/export interface SkillContextSource \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(2);
    expect(body).toContain('ensureLoaded(): Promise<void>');
    expect(body).toContain('formatForContext(): string');
    expect(source).toContain('export class SkillSystem implements SkillContextSource');
  });

  it('Runtime and ContextInjector see only the context source', () => {
    const runtimeTypes = read('src/core/runtime/types.ts');
    const injector = read('src/core/runtime/injector.ts');
    expect(runtimeTypes).toContain('readonly skillRegistry: SkillContextSource');
    expect(injector).toContain('skillRegistry?: SkillContextSource');
    expect(injector).toContain('private skillRegistry?: SkillContextSource');
    expect(runtimeTypes).not.toMatch(/import type \{ SkillSystem \}/);
    expect(injector).not.toMatch(/import type \{ SkillSystem \}/);
  });

  it('ContextInjector retains prewarm and formatting calls', () => {
    const source = read('src/core/runtime/injector.ts');
    expect(source).toContain('await this.skillRegistry.ensureLoaded()');
    expect(source).toContain('this.skillRegistry.formatForContext()');
  });
});
