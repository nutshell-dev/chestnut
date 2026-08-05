/**
 * Phase 1288 Step C: workspace audit capability 接管根数据路径 ratchet。
 * （自 audit-layout-boundary.test.ts 拆出、Phase 1292 Step B）
 *
 * 冻结：
 *  - createWorkspaceAudit 是 workspace 根审计唯一工厂：固定 AUDIT_PATHS.audit +
 *    自家 config store、经 barrel 导出；
 *  - Watchdog/CLI 根审计调用方统一 createWorkspaceAudit、零路径/retention/config 接触；
 *  - Watchdog audit wiring 零 Assembly config import（Phase 1289 Step C 校准：
 *    watchdog-context 已切自家 config store、零 Assembly config 引用、无 audit 段访问）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assemblyDir } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const AUDIT_DIR = path.join(SRC_ROOT, 'foundation', 'audit');

describe('phase 1288 Step C: workspace audit capability 接管根数据路径', () => {
  const WORKSPACE_AUDIT_FILE = path.join(AUDIT_DIR, 'workspace-audit.ts');
  // Watchdog 侧 audit wiring 三文件 + CLI 根审计调用方（stop）
  const ROOT_AUDIT_CALLERS = [
    'src/watchdog/audit-wiring.ts',
    'src/watchdog/watchdog.ts',
    'src/cli/commands/stop.ts',
  ];

  it('createWorkspaceAudit 是 workspace 根审计唯一工厂：固定 AUDIT_PATHS.audit + 自家 config store、经 barrel 导出', () => {
    const text = fs.readFileSync(WORKSPACE_AUDIT_FILE, 'utf8');
    expect(text).toContain('createWorkspaceAudit');
    expect(text).toContain('AUDIT_PATHS.audit');
    expect(text).toContain('readWorkspaceAuditRetentionMaxSizeMb');
    // 不暴露 maxSizeMb / AUDIT_FILE / raw config 给 caller（签名只接 fsFactory + chestnutRoot）
    const sig = text.match(/export function createWorkspaceAudit\(([\s\S]*?)\): AuditLog/);
    expect(sig, 'createWorkspaceAudit signature must exist').not.toBeNull();
    expect(sig![1]).toContain('fsFactory');
    expect(sig![1]).toContain('chestnutRoot');
    expect(sig![1]).not.toContain('maxSizeMb');
    const barrel = fs.readFileSync(path.join(AUDIT_DIR, 'index.ts'), 'utf8');
    expect(barrel).toContain("export { createWorkspaceAudit } from './workspace-audit.js';");
  });

  it('Watchdog/CLI 根审计调用方统一 createWorkspaceAudit、零路径/retention/config 接触', () => {
    const forbidden = ['createAuditWriter', 'AUDIT_FILE', 'readWorkspaceAuditRetentionMaxSizeMb'];
    for (const rel of [...ROOT_AUDIT_CALLERS, 'src/watchdog/watchdog-context.ts']) {
      const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      for (const token of forbidden) {
        expect(text.includes(token), `${rel} must not reference ${token}`).toBe(false);
      }
    }
    for (const rel of ROOT_AUDIT_CALLERS) {
      const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      expect(text.includes('createWorkspaceAudit'), `${rel} must construct via createWorkspaceAudit`).toBe(true);
    }
  });

  it('Watchdog audit wiring 零 Assembly config import（watchdog-context 已切自家 config store、无 audit 段访问）', () => {
    for (const rel of ['src/watchdog/audit-wiring.ts', 'src/watchdog/watchdog.ts']) {
      const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      expect(text.includes('assembly/config'), `${rel} must not import Assembly config for audit`).toBe(false);
    }
    // Phase 1289 Step C：watchdog runtime 监控参数消费已切至自家 workspace config store
    //（.chestnut/watchdog/config.yaml），watchdog-context.ts 不得再引用 Assembly config；
    // 且仍不得访问 audit 配置段
    const ctx = fs.readFileSync(path.join(PROJECT_ROOT, 'src/watchdog/watchdog-context.ts'), 'utf8');
    expect(ctx.includes('loadGlobalConfig'), 'watchdog-context.ts must not reference loadGlobalConfig').toBe(false);
    expect(ctx.includes('assembly/config'), 'watchdog-context.ts must not import Assembly config').toBe(false);
    expect(ctx).toContain('getWatchdogConfig');
    expect(ctx.includes('audit.retention')).toBe(false);
    expect(/config\.audit\b/.test(ctx)).toBe(false);
    expect(/globalConfig\.audit\b/i.test(ctx)).toBe(false);
  });
});
