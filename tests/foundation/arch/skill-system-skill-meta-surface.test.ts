import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registrySource = readFileSync(
  new URL('../../../src/foundation/skill-system/registry.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/skill-system/index.ts', import.meta.url),
  'utf8',
);

describe('SkillSystem SkillMeta deep surface', () => {
  it('keeps the skill meta shape local behind the public registry', () => {
    expect(registrySource).not.toMatch(/export\s+interface\s+SkillMeta\b/);
    expect(registrySource).toMatch(
      /(?:^|\n)interface\s+SkillMeta\s*\{[\s\S]*?name:\s*string;[\s\S]*?description:\s*string;[\s\S]*?version:\s*string;[\s\S]*?skillDir:\s*string;[\s\S]*?\}/,
    );
    expect(registrySource).toMatch(/register\(skillDir:\s*string\):\s*Promise<SkillMeta>/);
    expect(registrySource).toMatch(/getMeta\(name:\s*string\):\s*SkillMeta\s*\|\s*undefined/);
    expect(registrySource).toMatch(/listMeta\(\):\s*SkillMeta\[\]/);
    expect(barrelSource).toMatch(/export\s*\{\s*SkillSystem\s*\}\s*from\s*'\.\/registry\.js';/);
    expect(barrelSource).not.toMatch(/\bSkillMeta\b/);
  });
});
