import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/workspace-segments.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('WorkspaceAuditSegmentRecord surface', () => {
  it('keeps merged records local while preserving identity and ordering fields', () => {
    expect(source).not.toMatch(/export\s+interface\s+WorkspaceAuditSegmentRecord\b/);
    expect(source).toMatch(/interface\s+WorkspaceAuditSegmentRecord\s*{[\s\S]*segment:\s*{[\s\S]*origin:\s*WorkspaceAuditSegmentOrigin;[\s\S]*path:\s*string;[\s\S]*};[\s\S]*offset:\s*number;[\s\S]*record:\s*AuditRecord;/);
    expect(source).toMatch(/readWorkspaceAuditMerged\([\s\S]*?\):\s*Promise<WorkspaceAuditSegmentRecord\[\]>/);
    expect(source).toMatch(/const\s+collected:\s*Array<WorkspaceAuditSegmentRecord\s*&\s*{\s*segmentIndex:\s*number\s*}>/);
    expect(barrel).not.toMatch(/\bWorkspaceAuditSegmentRecord\b/);
    expect(barrel).toMatch(/\bWorkspaceAuditSegmentIssue\b/);
  });
});
