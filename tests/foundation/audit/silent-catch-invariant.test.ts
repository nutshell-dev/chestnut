/**
 * Phase 1324 C.4: mechanical silent-catch invariant lint
 * Mirror phase 964+1019+1244+1265+1266+1277+1278 N=8 cluster template.
 *
 * phase 272 Step E: TARGET_DIRS 扩 src-wide
 *
 * 历史 phase 1324 C.4 立 cluster-local lint (3 dir scope)、其他 19+ dir 含 silent catch 漂入不被 CI 拦。
 * 本 phase 扩 src-wide + 显式 allowlist by-design silent catch 子集 (mirror business-literal 53 file ratchet 模式)。
 *
 * 升档：allowlist 中条目应有明确 by-design 注释 anchor、定期 sweep 清理。
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const PROJECT_ROOT = new URL('../../../', import.meta.url).pathname;
const SRC_ROOT = `${PROJECT_ROOT}src`;

const TARGET_DIRS = ['src'];

// phase 272 Step E: by-design silent catch baseline allowlist (src-wide grep)
// 以下文件含显式 `catch { /* silent: ... */ }` 注释、属 by-design fail-soft / best-effort / race 路径。
// 升档：N >= 50 时拆 phase 续治、本 phase 仅 ratchet 守新增不漂。
const CATCH_SILENT_ALLOWLIST = new Set([
  // phase 1324 ratify
  'task-recovery.ts',
  'orchestrator.ts',
  // phase 272 Step E baseline (src-wide grep by-design silent catches)
  'chat-viewport-init.ts',
  'chat-viewport-input.ts',
  'claw-list.ts',
  'claw-trace.ts',
  'daemon-entry.ts',
  'daemon.ts',
  'ensure.ts',
  'inbox-watcher.ts',
  'onboarding-discovery.ts',
  'orphan-sweep.ts',
  'reader.ts',
  'stop.ts',
  'subagent-helpers.ts',
  'timeout-controller.ts',
  'watchdog-state.ts',
  'watchdog-utils.ts',
  'watcher.ts',
]);

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

describe('phase 1324 C.4 + phase 272 Step E: silent-catch mechanical invariant lint', () => {
  for (const dir of TARGET_DIRS) {
    const fullDir = `${PROJECT_ROOT}${dir}`;

    it(`${dir}: 0 bare .catch(() => {}) silent catch`, () => {
      const hits = grepInDir(fullDir, String.raw`\.catch\(\(\)\s*=>\s*\{\s*\}\)`);
      const unallowed = hits.filter(h => !Array.from(CATCH_SILENT_ALLOWLIST).some(a => h.includes(a)));
      expect(unallowed).toEqual([]);
    });

    it(`${dir}: 0 } catch { /* silent */ pattern without allowlist`, () => {
      const hits = grepInDir(fullDir, String.raw`}\s*catch\s*\{\s*/\*\s*silent`);
      const unallowed = hits.filter(h => !Array.from(CATCH_SILENT_ALLOWLIST).some(a => h.includes(a)));
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
