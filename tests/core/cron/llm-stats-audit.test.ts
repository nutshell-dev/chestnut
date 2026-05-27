/**
 * llm-stats audit emit 反向 3 项 verify（phase 930 r116 D fork）
 *
 * 覆盖路径：
 * - LLM_STATS audit emit row 含 avg_latency_ms= snake_case key
 * - row 不含 avgLatencyMs= camelCase 旧 key
 * - numeric value 形态保持
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { runLlmStats, type LlmStatsOptions } from '../../../src/core/cron/jobs/llm-stats.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';

describe('phase 930: LLM_STATS audit emit avg_latency_ms key', () => {
  it('audit emit row 含 avg_latency_ms= snake_case key', async () => {
    const clawforumDir = await createTempDir();
    const motionDir = path.join(clawforumDir, 'motion');
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
    const audit = { write: (...args: any[]) => writes.push(args) };

    const opts: LlmStatsOptions = {
      clawforumDir,
      motionDir,
      clawforumFs: new NodeFileSystem({ baseDir: clawforumDir }),
      motionFs: new NodeFileSystem({ baseDir: motionDir }),
      audit: audit as any,
    };

    await runLlmStats(opts);

    // 找 LLM_STATS row of step=report
    const reportRow = writes.find(
      args => args[0] === CRON_AUDIT_EVENTS.LLM_STATS && args.includes('step=report')
    );
    expect(reportRow).toBeDefined();

    // 反向 1: 含 avg_latency_ms snake_case
    expect(reportRow!.some((a: string) => a.startsWith('avg_latency_ms='))).toBe(true);

    // 反向 2: 不含 avgLatencyMs camelCase（旧 key migration verify）
    expect(reportRow!.some((a: string) => a.startsWith('avgLatencyMs='))).toBe(false);

    // 反向 3: numeric value 形态（snake_case key= 后跟数字）
    const latencyArg = reportRow!.find((a: string) => a.startsWith('avg_latency_ms=')) as string;
    expect(latencyArg).toMatch(/^avg_latency_ms=\d+$/);
    // (200 + 300) / 2 = 250
    expect(latencyArg).toBe('avg_latency_ms=250');

    await cleanupTempDir(clawforumDir);
  });
});
