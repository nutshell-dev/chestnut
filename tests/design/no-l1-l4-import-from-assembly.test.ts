/**
 * phase 117 ratchet: L1-L4 不 import from src/assembly/（L6 装配层）
 *
 * 应然：ML#5 单向。L1 primitive + L2 基础设施 + L3 通用 + L4 业务都不上引 L6。
 *
 * 当前实然 20 file allow-list = tech debt (主因 ChestnutRoot brand + getClawDir helper +
 * install-paths 仍 L6 own、L1-L4 反向 import 取 brand/helper)、留 design-gap。
 * 新增 hit → 测 fail = ratchet 守。
 *
 * 后续 cluster 治理目标: 清空 allow-list (brand vocabulary 物理迁 L1 vocabulary file 或
 * 各模块 own factory)。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import path from 'node:path';

const ASSEMBLY_IMPORT_PATTERN = /from\s+['"][^'"]*\/assembly\/[^'"]*['"]/;

const BASELINE_ALLOW_LIST = new Set([
  // L1 foundation/ (9)
  'src/foundation/config/crud.ts',
  'src/foundation/config/global-config-path.ts',
  'src/foundation/config/index.ts',
  'src/foundation/file-tool/read.ts',
  'src/foundation/llm-orchestrator/config-adapter.ts',
  'src/foundation/process-manager/manager.ts',
  'src/foundation/process-manager/signal-clean-stop.ts',
  'src/foundation/tools/context.ts',
  'src/foundation/tools/executor.ts',
  // L4 core/ (11)
  'src/core/async-task-system/system.ts',
  'src/core/contract/persistence.ts',
  'src/core/cron/jobs/disk-monitor.ts',
  'src/core/cron/jobs/llm-stats.ts',
  'src/core/evolution-system/system.ts',
  'src/core/memory/deep-dream.ts',
  'src/core/permissions/claw-permissions.ts',
  'src/core/status-service/aggregators.ts',
  'src/core/status-service/forum-aggregators.ts',
  'src/core/subagent/run.ts',
  'src/core/summon-system/index.ts',
]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (p.endsWith('.ts')) files.push(p);
  }
  return files;
}

describe('phase 117: ML#5 ratchet — L1-L4 不 import from src/assembly/ (L6)', () => {
  it('src/foundation/ + src/core/ 不新增 import from src/assembly/ (baseline ratchet)', () => {
    const files = [...walk('src/foundation'), ...walk('src/core')];
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      if (ASSEMBLY_IMPORT_PATTERN.test(src)) {
        hits.push(file);
      }
    }
    const newHits = hits.filter((f) => !BASELINE_ALLOW_LIST.has(f));
    if (newHits.length > 0) {
      expect.fail(
        `phase 117 ratchet: NEW L1-L4 → L6 (assembly) import (${newHits.length}):\n` +
          newHits.map((f) => `  ${f}`).join('\n') +
          '\nFix: 装配期 caller (L6) 注入需要的 value via DI, 不在 L1-L4 内 import 反向。' +
          '\n若 unavoidable (legacy brand vocabulary): 加入 BASELINE_ALLOW_LIST 加 design-gap 登记。',
      );
    }
  });

  it('BASELINE_ALLOW_LIST 不退化 (allow-list 内 file 仍含 assembly import)', () => {
    const stale: string[] = [];
    for (const file of BASELINE_ALLOW_LIST) {
      let src: string;
      try {
        src = readFileSync(file, 'utf-8');
      } catch {
        stale.push(`${file} (file 不存)`);
        continue;
      }
      if (!ASSEMBLY_IMPORT_PATTERN.test(src)) {
        stale.push(`${file} (无 hit, 应从 allow-list 移除)`);
      }
    }
    if (stale.length > 0) {
      expect.fail(
        `BASELINE_ALLOW_LIST 退化 (${stale.length} 个 stale entry):\n` +
          stale.map((s) => `  ${s}`).join('\n') +
          '\n请从 allow-list 移除该 entry, baseline 缩小 = cluster 治理进展。',
      );
    }
  });
});
