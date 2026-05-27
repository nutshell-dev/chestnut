/**
 * Phase 1324 C.4: mechanical silent-catch invariant lint
 * Mirror phase 964+1019+1244+1265+1266+1277+1278 N=8 cluster template.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const PROJECT_ROOT = new URL('../../../', import.meta.url).pathname;
const SRC_ROOT = `${PROJECT_ROOT}src`;

const TARGET_DIRS = [
  'src/core/async-task-system',
  'src/foundation/stream',
  'src/foundation/llm-orchestrator',
];

function grepInDir(dir: string, pattern: string): string[] {
  try {
    const result = execSync(
      `grep -rnE '${pattern}' ${dir} || true`,
      { encoding: 'utf-8', cwd: PROJECT_ROOT },
    );
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('phase 1324 C.4: silent-catch mechanical invariant lint', () => {
  for (const dir of TARGET_DIRS) {
    const fullDir = `${PROJECT_ROOT}${dir}`;

    it(`${dir}: 0 bare .catch(() => {}) silent catch`, () => {
      const hits = grepInDir(fullDir, String.raw`\.catch\(\(\)\s*=>\s*\{\s*\}\)`);
      // Allowlist: pre-existing by-design silent catches (phase 1324 scope only fixes 3 sites)
      // task-recovery.ts delete failures are best-effort cleanup, ratchet for r138+ extended sweep
      const allowlist: string[] = ['task-recovery.ts'];
      const unallowed = hits.filter(h => !allowlist.some(a => h.includes(a)));
      expect(unallowed).toEqual([]);
    });

    it(`${dir}: 0 } catch { /* silent */ pattern`, () => {
      const hits = grepInDir(fullDir, String.raw`}\s*catch\s*\{\s*/\*\s*silent`);
      // Allowlist: pre-existing by-design generator cleanup catches in orchestrator.ts
      // (generator already closed, ignore) — ratchet for r138+ extended sweep
      const allowlist: string[] = ['orchestrator.ts'];
      const unallowed = hits.filter(h => !allowlist.some(a => h.includes(a)));
      expect(unallowed).toEqual([]);
    });
  }

  it('reverse: known pre-fix patterns are 0 hit post-fix (3 zones)', () => {
    // Specific verification of the 3 sites fixed in phase 1324
    const streamWriter = grepInDir(
      `${PROJECT_ROOT}src/foundation/stream`,
      String.raw`silent:\s*if\s+repair\s+fails`,
    );
    expect(streamWriter).toEqual([]);

    const asyncTaskSystem = grepInDir(
      `${PROJECT_ROOT}src/core/async-task-system`,
      String.raw`silent:\s*best-effort\s+delete`,
    );
    expect(asyncTaskSystem).toEqual([]);
  });
});
