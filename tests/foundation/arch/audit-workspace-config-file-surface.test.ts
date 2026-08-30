import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/config-schema.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('AuditWorkspaceConfigFile surface', () => {
  it('keeps the inferred config file type local behind its factory', () => {
    expect(source).not.toMatch(/export\s+type\s+AuditWorkspaceConfigFile\b/);
    expect(source).toMatch(/type\s+AuditWorkspaceConfigFile\s*=\s*z\.infer<typeof auditWorkspaceConfigFileSchema>;/);
    expect(source).toMatch(/export\s+function\s+createDefaultAuditWorkspaceConfig\(\):\s*AuditWorkspaceConfigFile/);
    expect(barrel).not.toMatch(/\bAuditWorkspaceConfigFile\b/);
  });
});
