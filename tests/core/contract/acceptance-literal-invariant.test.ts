/**
 * Phase 1267 D.3: acceptance→verification rename sweep lint test
 *
 * Verifies 0 occurrences of `acceptance` literal in src/core/contract/
 * except the backwards-compat migrate section in persistence.ts:66-77.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'path';

describe('phase 1267 D.3: acceptance literal 0 hit in src/core/contract/ (except backwards-compat)', () => {
  it('grep acceptance in src/core/contract/ → only persistence.ts backwards-compat section', async () => {
    const contractDir = 'src/core/contract';
    const entries = await fs.readdir(contractDir);
    const hits: Array<{ file: string; line: number; text: string }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const filePath = path.join(contractDir, entry);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('acceptance')) continue;

        // Allow the backwards-compat section in persistence.ts (lines ~66-77)
        if (entry === 'persistence.ts' && i >= 65 && i <= 76) continue;

        // Allow audit event constant names that reference legacy field
        if (line.includes('CONTRACT_YAML_LEGACY_ACCEPTANCE_FIELD')) continue;

        hits.push({ file: entry, line: i + 1, text: line.trim() });
      }
    }

    expect(hits).toEqual([]);
  });

  it('verification.ts parameter renamed to verificationConfig', async () => {
    const content = await fs.readFile('src/core/contract/verification.ts', 'utf-8');
    expect(content).toContain('verificationConfig: VerificationConfig');
    expect(content).not.toContain('acceptanceConfig: VerificationConfig');
  });

  it('audit-events.ts comment references verification.ts not acceptance.ts', async () => {
    const content = await fs.readFile('src/core/contract/audit-events.ts', 'utf-8');
    expect(content).toContain('verification.ts 7 处字面量收');
    expect(content).not.toContain('acceptance.ts 7 处字面量收');
  });

  it('persistence.ts comment references verification.ts:75 not acceptance.ts:75', async () => {
    const content = await fs.readFile('src/core/contract/persistence.ts', 'utf-8');
    expect(content).toContain('verification.ts:75');
    expect(content).not.toContain('acceptance.ts:75');
  });
});
