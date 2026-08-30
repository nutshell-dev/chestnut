import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/workspace-config.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('WorkspaceAuditConfigResult surface', () => {
  it('keeps the read result carrier local behind workspace config operations', () => {
    expect(source).not.toMatch(/export\s+type\s+WorkspaceAuditConfigResult\b/);
    expect(source).toMatch(/type\s+WorkspaceAuditConfigResult\s*=\s*[\s\S]*kind:\s*'ok';\s*config:\s*AuditConfig[\s\S]*kind:\s*'missing'[\s\S]*kind:\s*'invalid';\s*message:\s*string/);
    expect(source).toMatch(/loadWorkspaceAuditConfig\(fs:\s*FileSystem\):\s*WorkspaceAuditConfigResult/);
    expect(barrel).not.toMatch(/\bWorkspaceAuditConfigResult\b/);
  });
});
