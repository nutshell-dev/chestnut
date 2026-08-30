import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/workspace-segments.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('WorkspaceAuditSegmentUnreadable surface', () => {
  it('keeps the failed variant local while retaining the public issue', () => {
    expect(source).not.toMatch(/export\s+interface\s+WorkspaceAuditSegmentUnreadable\b/);
    expect(source).toMatch(/interface\s+WorkspaceAuditSegmentUnreadable\s+extends\s+WorkspaceAuditSegmentBase\s*{[\s\S]*status:\s*'unreadable';[\s\S]*issue:\s*WorkspaceAuditSegmentIssue;/);
    expect(source).toMatch(/type\s+WorkspaceAuditSegment\s*=[\s\S]*WorkspaceAuditSegmentUnreadable/);
    expect(source).toMatch(/export\s+interface\s+WorkspaceAuditSegmentIssue\b/);
    expect(barrel).not.toMatch(/\bWorkspaceAuditSegmentUnreadable\b/);
    expect(barrel).toMatch(/\bWorkspaceAuditSegmentIssue\b/);
  });
});
