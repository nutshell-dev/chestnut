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

describe('SkillSystem SkillToolOptions deep surface', () => {
  it('keeps the factory options shape local behind the public factory', () => {
    expect(skillToolSource).not.toMatch(/export\s+interface\s+SkillToolOptions\b/);
    expect(skillToolSource).toMatch(
      /(?:^|\n)interface\s+SkillToolOptions\s*\{[\s\S]*?dispatchSkillsDir\?:\s*string;[\s\S]*?\}/,
    );
    expect(skillToolSource).toMatch(
      /createSkillTool\(skillRegistry:\s*SkillSystem,\s*opts:\s*SkillToolOptions\s*=\s*\{\}\)/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{\s*createSkillTool\s*\}\s*from\s*'\.\/tools\/skill\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bSkillToolOptions\b/);
  });
});
