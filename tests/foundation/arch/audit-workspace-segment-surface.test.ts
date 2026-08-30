import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/workspace-segments.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('WorkspaceAuditSegment surface', () => {
  it('keeps the three-state union local behind segment operations', () => {
    expect(source).not.toMatch(/export\s+type\s+WorkspaceAuditSegment\b/);
    expect(source).toMatch(/type\s+WorkspaceAuditSegment\s*=\s*[\s\S]*WorkspaceAuditSegmentOk[\s\S]*WorkspaceAuditSegmentMissing[\s\S]*WorkspaceAuditSegmentUnreadable;/);
    expect(source).toMatch(/listWorkspaceAuditSegments\([\s\S]*?\):\s*WorkspaceAuditSegment\[\]/);
    expect(source).toMatch(/readWorkspaceAuditMerged\([\s\S]*segments:\s*readonly\s+WorkspaceAuditSegment\[\]/);
    expect(barrel).not.toMatch(/\bWorkspaceAuditSegment\b/);
    expect(barrel).toMatch(/\bWorkspaceAuditSegmentIssue\b/);
  });
});
