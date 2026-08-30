import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/foundation/audit/jobs/audit-size-monitor.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');
describe('AuditSizeMonitorOptions surface', () => {
  it('keeps options local behind runAuditSizeMonitor', () => {
    expect(source).not.toMatch(/export\s+interface\s+AuditSizeMonitorOptions\b/);
    expect(source).toMatch(/interface\s+AuditSizeMonitorOptions\s*\{[\s\S]*fs:\s*FileSystem;[\s\S]*audit:\s*AuditLog;[\s\S]*legacyAuditPath:\s*string;[\s\S]*signal\?:\s*AbortSignal;[\s\S]*\}/);
    expect(source).toMatch(/export\s+async\s+function\s+runAuditSizeMonitor\(opts:\s*AuditSizeMonitorOptions\)/);
    expect(barrel).not.toMatch(/\bAuditSizeMonitorOptions\b/);
  });
});
