/**
 * @module tests/core/contract/verifier-job-no-workspace-dir-invariant
 * Phase 1371 sub-6: verifier-job signal abort cleanup invariant test
 *
 * Enforces the phase 805 assumption: runSubagent does NOT create a subagent workspace dir.
 *
 * NEW hit ratchet (`ensureDir|mkdir(workspace)`) 已迁 ESLint custom rule
 * `chestnut-custom/no-subagent-ensuredir-workspace` (phase 402)。本 file 仅留
 * cross-file aggregate count baseline (ESLint per-file scope 不擅长跨文件 count)。
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

describe('verifier-job no-workspace-dir invariant (phase 1371 sub-6 count baseline)', () => {
  it('subagent source baseline: ensureDir is only used for resultDir (count = 2)', () => {
    const files = readSrcFiles('src/core/subagent');
    let ensureDirCount = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const matches = content.match(/ensureDir\(/g);
      if (matches) ensureDirCount += matches.length;
    }

    // Current baseline: run.ts (1) + agent.ts (1) = 2 ensureDir calls for resultDir
    // If this number increases, a human must verify it's not workspace dir creation.
    // (NEW workspace dir ensureDir 已由 ESLint `no-subagent-ensuredir-workspace` 守 phase 402)
    expect(ensureDirCount).toBe(2);
  });
});
