import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/workspace-segments.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('WorkspaceAuditSegmentMissing surface', () => {
  it('keeps the legal missing variant local behind the segment union', () => {
    expect(source).not.toMatch(/export\s+interface\s+WorkspaceAuditSegmentMissing\b/);
    expect(source).toMatch(/interface\s+WorkspaceAuditSegmentMissing\s+extends\s+WorkspaceAuditSegmentBase\s*{[\s\S]*status:\s*'missing';[\s\S]*}/);
    expect(source).toMatch(/type\s+WorkspaceAuditSegment\s*=[\s\S]*WorkspaceAuditSegmentMissing/);
    expect(barrel).not.toMatch(/\bWorkspaceAuditSegmentMissing\b/);
  });
});
