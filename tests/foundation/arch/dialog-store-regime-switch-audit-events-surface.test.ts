import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const regimeSwitchSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/regime-switch.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/index.ts', import.meta.url),
  'utf8',
);

describe('DialogStore RegimeSwitchAuditEvents deep surface', () => {
  it('keeps the audit events type local behind performRegimeSwitch', () => {
    expect(regimeSwitchSource).not.toMatch(/export\s+interface\s+RegimeSwitchAuditEvents\s*\{/);
    expect(regimeSwitchSource).toMatch(
      /(?:^|\n)interface\s+RegimeSwitchAuditEvents\s*\{[\s\S]*?\bREGIME_SWITCH:\s*string;[\s\S]*?\bREGIME_SWITCH_COMMITTED:\s*string;[\s\S]*?\bREGIME_SWITCH_FAILED:\s*string;[\s\S]*?\bREGIME_SWITCH_HARD_FAIL:\s*string;[\s\S]*?\}/,
    );
    expect(regimeSwitchSource).toMatch(/auditEvents:\s*RegimeSwitchAuditEvents;/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bperformRegimeSwitch\b[^}]*\}\s*from\s*'\.\/regime-switch\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bRegimeSwitchAuditEvents\b/);
  });
});
