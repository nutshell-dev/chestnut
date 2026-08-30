import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/workspace-segments.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('WorkspaceAuditSegmentOk surface', () => {
  it('keeps the readable variant local behind the segment union', () => {
    expect(source).not.toMatch(/export\s+interface\s+WorkspaceAuditSegmentOk\b/);
    expect(source).toMatch(/interface\s+WorkspaceAuditSegmentOk\s+extends\s+WorkspaceAuditSegmentBase\s*{[\s\S]*status:\s*'ok';[\s\S]*read\(opts\?:\s*ReadOptions\):\s*AsyncIterableIterator<AuditRecord>;/);
    expect(source).toMatch(/type\s+WorkspaceAuditSegment\s*=[\s\S]*WorkspaceAuditSegmentOk/);
    expect(barrel).not.toMatch(/\bWorkspaceAuditSegmentOk\b/);
  });
});
