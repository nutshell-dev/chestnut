import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skillToolSource = readFileSync(
  new URL('../../../src/foundation/skill-system/tools/skill.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/skill-system/index.ts', import.meta.url),
  'utf8',
);

describe('SkillSystem SkillScope deep surface', () => {
  it('keeps the scope union local behind the public factory', () => {
    expect(skillToolSource).not.toMatch(/export\s+type\s+SkillScope\b/);
    expect(skillToolSource).toMatch(
      /(?:^|\n)type\s+SkillScope\s*=\s*'self'\s*\|\s*'dispatch';/,
    );
    expect(skillToolSource).toMatch(/args\.scope\s+as\s+SkillScope\s*\|\s*undefined/);
    expect(barrelSource).toMatch(
      /export\s*\{\s*createSkillTool\s*\}\s*from\s*'\.\/tools\/skill\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bSkillScope\b/);
  });
});
