import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/archive-payload-layout.ts', import.meta.url), 'utf8');
describe('SubtaskRetrySummary surface', () => {
  it('keeps retry summaries local with the complete failure shape', () => {
    expect(source).not.toMatch(/export\s+interface\s+SubtaskRetrySummary\b/);
    expect(source).toMatch(/interface\s+SubtaskRetrySummary\s*{[\s\S]*retryCount:\s*number;[\s\S]*lastFailure\?:\s*{[\s\S]*attemptId:\s*string;[\s\S]*finishedAt:\s*string;[\s\S]*feedback\?:\s*string;[\s\S]*cause\?:\s*string;/);
    expect(source).toMatch(/deriveSubtaskRetrySummary\([\s\S]*?\):\s*SubtaskRetrySummary/);
  });
});
