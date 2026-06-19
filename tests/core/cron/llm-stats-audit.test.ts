/**
 * llm-stats audit emit verify（phase 930 r116 D fork + phase 180 升档）
 *
 * 覆盖路径：
 * - LLM_STATS_REPORTED event emit（phase 180 拆 sub-event）
 * - row 含 avgLatencyMs= camelCase key（phase 180 纠 snake_case 漂）
 * - row 不含 avg_latency_ms= snake_case 旧 key
 * - numeric value 形态保持
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { runLlmStats, type LlmStatsOptions } from '../../../src/core/cron/jobs/llm-stats.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { LLM_STATS_AUDIT_EVENTS } from '../../../src/core/cron/jobs/llm-stats-audit-events.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { makeClawId } from '../../../src/foundation/identity/claw-id.js';

describe('phase 930 + 180: LLM_STATS audit emit avgLatencyMs key', () => {
  it('audit emit row 含 avgLatencyMs= camelCase key', async () => {
    const chestnutDir = await createTempDir();
    const motionDir = path.join(chestnutDir, 'motion');
    await fs.mkdir(motionDir, { recursive: true });

    const yesterday = new Date(Date.now() - 86400000);
    const targetDate = yesterday.toISOString().slice(0, 10);

    // 构造 audit.tsv 含 2 条 llm_call 行（latency_ms 各 200 / 300 → avg 250）
    const auditLines = [
      `${targetDate}T10:00:00Z\tllm_call\tgpt-4\tin=100\tout=50\tms=200`,
      `${targetDate}T11:00:00Z\tllm_call\tgpt-4\tin=150\tout=75\tms=300`,
    ].join('\n');

    await fs.writeFile(path.join(motionDir, 'audit.tsv'), auditLines, 'utf-8');

    const writes: any[][] = [];
    const audit = { write: (...args: any[]) => writes.push(args) , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s};

    const chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
    const topology = createClawTopology({
      fs: chestnutFs,
      chestnutRoot: chestnutDir,
      motionClawId: makeClawId('motion'),
      motionDir,
    });

    const opts: LlmStatsOptions = {
      chestnutDir,
      motionDir,
      chestnutFs,
      motionFs: new NodeFileSystem({ baseDir: motionDir }),
      clawTopology: topology,
      audit: audit as any,
    };

    await runLlmStats(opts);

    // phase 180: 找 LLM_STATS_REPORTED row（step=report 已砍）
    const reportRow = writes.find(
      args => args[0] === LLM_STATS_AUDIT_EVENTS.LLM_STATS_REPORTED
    );
    expect(reportRow).toBeDefined();

    // 正向: 含 avgLatencyMs camelCase（phase 180 纠 snake_case 漂）
    expect(reportRow!.some((a: string) => a.startsWith('avgLatencyMs='))).toBe(true);

    // 反向: 不含 avg_latency_ms snake_case（旧 key 已砍）
    expect(reportRow!.some((a: string) => a.startsWith('avg_latency_ms='))).toBe(false);

    // numeric value 形态
    const latencyArg = reportRow!.find((a: string) => a.startsWith('avgLatencyMs=')) as string;
    expect(latencyArg).toMatch(/^avgLatencyMs=\d+$/);
    // (200 + 300) / 2 = 250
    expect(latencyArg).toBe('avgLatencyMs=250');

    await cleanupTempDir(chestnutDir);
  });
});
