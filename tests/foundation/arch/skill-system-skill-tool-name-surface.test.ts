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

describe('SkillSystem SKILL_TOOL_NAME deep surface', () => {
  it('keeps the skill tool name literal local behind the public factory', () => {
    expect(skillToolSource).not.toMatch(/export\s+const\s+SKILL_TOOL_NAME\b/);
    expect(skillToolSource).toMatch(
      /(?:^|\n)const\s+SKILL_TOOL_NAME\s*=\s*'skill'\s+as\s+const;/,
    );
    expect(skillToolSource).toMatch(/name:\s*SKILL_TOOL_NAME,/);
    expect(barrelSource).toMatch(
      /export\s*\{\s*createSkillTool\s*\}\s*from\s*'\.\/tools\/skill\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bSKILL_TOOL_NAME\b/);
  });
});
