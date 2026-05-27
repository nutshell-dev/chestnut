/**
 * @module tests/core/contract/verifier-job-no-workspace-dir-invariant
 * Phase 1371 sub-6: verifier-job signal abort cleanup invariant test
 *
 * Enforces the phase 805 assumption: runSubagent does NOT create a subagent workspace dir.
 * If this assumption changes, this test fails immediately — forcing explicit cleanup code.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';

function readSrcFiles(dir: string): string[] {
  const root = path.resolve(process.cwd(), dir);
  const results: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...readSrcFiles(path.join(dir, entry)));
    } else if (full.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('verifier-job no-workspace-dir invariant (phase 1371 sub-6)', () => {
  it('subagent source contains 0 ensureDir/mkdir calls targeting workspace dir', () => {
    const files = readSrcFiles('src/core/subagent');
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Look for ensureDir or mkdir that mentions workspace
        if (/ensureDir|mkdir|mkdirSync/.test(line) && /workspace|CLAWSPACE|workspaceDir/i.test(line)) {
          violations.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('subagent source baseline: ensureDir is only used for resultDir', () => {
    const files = readSrcFiles('src/core/subagent');
    let ensureDirCount = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const matches = content.match(/ensureDir\(/g);
      if (matches) ensureDirCount += matches.length;
    }

    // Current baseline: run.ts (1) + agent.ts (1) = 2 ensureDir calls for resultDir
    // If this number increases, a human must verify it's not workspace dir creation.
    expect(ensureDirCount).toBe(2);
  });
});
