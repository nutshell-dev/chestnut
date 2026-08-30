import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/workspace-segments.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('WorkspaceAuditSegmentOrigin surface', () => {
  it('keeps the origin alias local while preserving issue structure', () => {
    expect(source).not.toMatch(/export\s+type\s+WorkspaceAuditSegmentOrigin\b/);
    expect(source).toMatch(/type\s+WorkspaceAuditSegmentOrigin\s*=\s*'legacy'\s*\|\s*'new'/);
    expect(source).toMatch(/export\s+interface\s+WorkspaceAuditSegmentIssue\s*{[\s\S]*origin:\s*WorkspaceAuditSegmentOrigin;/);
    expect(source).toMatch(/interface\s+WorkspaceAuditSegmentBase\s*{[\s\S]*origin:\s*WorkspaceAuditSegmentOrigin;/);
    expect(barrel).not.toMatch(/\bWorkspaceAuditSegmentOrigin\b/);
    expect(barrel).toMatch(/\bWorkspaceAuditSegmentIssue\b/);
  });
});
