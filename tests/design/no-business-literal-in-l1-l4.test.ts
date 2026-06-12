/**
 * phase 117 ratchet: L1-L4 不持 chestnut 业务角色 literal / MOTION_CLAW_ID ident
 *
 * 应然：L1 primitive + L2 基础设施 + L3 通用算法 + L4 业务模块都不预设上层业务语义
 * （motion / claw / subagent / verifier / shadow / miner 业务角色字面，
 * MOTION_CLAW_ID 命名常量同性质硬绑）。
 *
 * 测策略：grep + baseline allow-list（同 phase 1395 foundation-invariants pattern）。
 * 当前实然 53 file allow-list = tech debt、留 design-gap；新增 hit → 测 fail。
 *
 * 后续 cluster 治理目标：清空 allow-list。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import path from 'node:path';

const BUSINESS_LITERAL_PATTERN = /['"`](motion|claw|subagent|verifier|shadow|miner)['"`]|\bMOTION_CLAW_ID\b/;

const BASELINE_ALLOW_LIST = new Set([
  // L1 foundation/ (16)
  'src/foundation/command-tool/exec.ts',
  'src/foundation/file-tool/edit.ts',
  'src/foundation/file-tool/ls.ts',
  'src/foundation/file-tool/multi_edit.ts',
  'src/foundation/file-tool/read.ts',
  'src/foundation/file-tool/search.ts',
  'src/foundation/file-tool/write.ts',
  'src/foundation/messaging/notify.ts',
  'src/foundation/messaging/tools/notify-claw.ts',
  'src/foundation/messaging/tools/send.ts',
  'src/foundation/process-manager/agent-factory.ts',
  'src/foundation/process-manager/types.ts',
  'src/foundation/skill-system/tools/skill.ts',
  'src/foundation/tools/context.ts',
  'src/foundation/tools/executor.ts',
  'src/foundation/tools/types.ts',
  // L4 core/ (37)
  'src/core/async-task-system/result-delivery.ts',
  'src/core/async-task-system/subagent-executor.ts',
  'src/core/async-task-system/system.ts',
  'src/core/async-task-system/task-schemas.ts',
  'src/core/async-task-system/tools/_pending-tool-task-writer.ts',
  'src/core/async-task-system/types.ts',
  'src/core/caller-types.ts',
  'src/core/contract/jobs/contract-observer.ts',
  'src/core/contract/verifier-job.ts',
  'src/core/cron/jobs/llm-stats.ts',
  'src/core/cron/jobs/git-gc-weekly-audit-events.ts',  // phase 180: col schema 定义含 'claw' 列名（audit event col、非业务逻辑硬绑）
  'src/core/evolution-system/retro-scheduler.ts',
  'src/core/heartbeat/heartbeat.ts',
  'src/core/memory/random-dream.ts',
  'src/core/memory/tools/memory_search.ts',
  'src/core/cron/jobs/outbox-summary/scan.ts',
  'src/core/cron/jobs/outbox-summary/write.ts',
  'src/core/cron/jobs/disk-monitor.ts',        // phase 259: MOTION_CLAW_ID filter in enumerate
  'src/core/cron/jobs/git-gc-weekly.ts',        // phase 259: MOTION_CLAW_ID filter in enumerate
  'src/core/memory/deep-dream.ts',              // phase 259: MOTION_CLAW_ID filter in enumerate
  'src/core/runtime/claw-config-schema.ts',
  'src/core/runtime/create-runtime.ts',
  'src/core/runtime/runtime.ts',
  'src/core/shadow-system/constants.ts',
  'src/core/shadow-system/spawn-shadow-subagent.ts',
  'src/core/shadow-system/system.ts',
  'src/core/shadow-system/tools/shadow.ts',
  'src/core/shadow-system/types.ts',
  'src/core/spawn-system/system.ts',
  'src/core/spawn-system/tools/spawn.ts',
  'src/core/status-service/forum-aggregators.ts',
  'src/core/status-service/forum-formatter.ts',
  'src/core/status-service/status-tool.ts',
  'src/core/subagent/agent.ts',
  'src/core/subagent/tools/done.ts',
  'src/core/summon-system/audit-events.ts',
  'src/core/summon-system/caller-types.ts',
  'src/core/summon-system/post-processors/contract-extract.ts',
  'src/core/summon-system/tools/ask-motion.ts',
  'src/core/summon-system/tools/summon.ts',
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

describe('phase 117: L1-L4 不预设上层业务语义 ratchet', () => {
  it('src/foundation/ + src/core/ 不新增 chestnut business literal / MOTION_CLAW_ID hit (baseline ratchet)', () => {
    const files = [...walk('src/foundation'), ...walk('src/core')];
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      if (BUSINESS_LITERAL_PATTERN.test(src)) {
        hits.push(file);
      }
    }
    const newHits = hits.filter((f) => !BASELINE_ALLOW_LIST.has(f));
    if (newHits.length > 0) {
      expect.fail(
        `phase 117 ratchet: NEW chestnut business literal / MOTION_CLAW_ID in L1-L4 (${newHits.length}):\n` +
          newHits.map((f) => `  ${f}`).join('\n') +
          '\nFix: pass via DI (装配期 caller 传 plain string)、不在 L1-L4 内硬绑 business literal。' +
          '\n若 unavoidable (legacy): 加入 BASELINE_ALLOW_LIST 加 design-gap 登记。',
      );
    }
  });

  it('BASELINE_ALLOW_LIST 不退化 (allow-list 内 file 实然仍含 hit, 不会有 stale entry)', () => {
    const stale: string[] = [];
    for (const file of BASELINE_ALLOW_LIST) {
      let src: string;
      try {
        src = readFileSync(file, 'utf-8');
      } catch {
        stale.push(`${file} (file 不存)`);
        continue;
      }
      if (!BUSINESS_LITERAL_PATTERN.test(src)) {
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
