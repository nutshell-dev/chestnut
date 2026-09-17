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

describe('DialogStore regime switch audit events deep surface (phase 1850 Step E)', () => {
  it('RegimeSwitchAuditEvents 不存在；事件常量自 owner ./audit-events.js 引用', () => {
    // 反向锁：caller 注入事件词汇的 interface / opts 字段均不得存在
    expect(regimeSwitchSource).not.toMatch(/\bRegimeSwitchAuditEvents\b/);
    expect(regimeSwitchSource).not.toMatch(/\bauditEvents\s*:/);
    // regime-switch.ts 自 './audit-events.js' 引用 owner 常量
    expect(regimeSwitchSource).toMatch(
      /import\s*\{[^}]*\bDIALOG_AUDIT_EVENTS\b[^}]*\}\s*from\s*'\.\/audit-events\.js';/,
    );
    expect(regimeSwitchSource).toMatch(/\bDIALOG_AUDIT_EVENTS\.REGIME_SWITCH\b/);
    expect(regimeSwitchSource).toMatch(/\bDIALOG_AUDIT_EVENTS\.REGIME_SWITCH_COMMITTED\b/);
    expect(regimeSwitchSource).toMatch(/\bDIALOG_AUDIT_EVENTS\.REGIME_SWITCH_FAILED\b/);
    expect(regimeSwitchSource).toMatch(/\bDIALOG_AUDIT_EVENTS\.REGIME_SWITCH_HARD_FAIL\b/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bperformRegimeSwitch\b[^}]*\}\s*from\s*'\.\/regime-switch\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bRegimeSwitchAuditEvents\b/);
  });
});
