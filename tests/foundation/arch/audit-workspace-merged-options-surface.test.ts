import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/workspace-segments.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('WorkspaceAuditMergedOptions surface', () => {
  it('keeps merged options local while preserving the public issue contract', () => {
    expect(source).not.toMatch(/export\s+interface\s+WorkspaceAuditMergedOptions\b/);
    expect(source).toMatch(/interface\s+WorkspaceAuditMergedOptions\s+extends\s+ReadOptions\s*{[\s\S]*onIssue\?:\s*\(issue:\s*WorkspaceAuditSegmentIssue\)\s*=>\s*void;/);
    expect(source).toMatch(/readWorkspaceAuditMerged\([\s\S]*opts:\s*WorkspaceAuditMergedOptions\s*=\s*{}/);
    expect(source).toMatch(/export\s+interface\s+WorkspaceAuditSegmentIssue\b/);
    expect(barrel).not.toMatch(/\bWorkspaceAuditMergedOptions\b/);
    expect(barrel).toMatch(/\bWorkspaceAuditSegmentIssue\b/);
  });
});
