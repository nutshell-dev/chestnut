import * as path from 'path';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import { CLAWS_DIR } from '../../../assembly/claw-dirs.js';
import { MOTION_CLAW_ID } from '../../../constants.js';
import { type ClawId, makeClawId } from '../../../foundation/paths.js'
import { type ClawDir } from '../../../foundation/paths.js';
import type { CronJob } from '../runner.js';
import { parseSchedule } from '../runner.js';
import type { ClawGlobalConfig } from '../../../foundation/config/index.js';


/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const LLM_STATS_CRON_TIMEOUT_MS = 60_000;

const LLM_STATS_FILE = 'logs/llm-stats.jsonl';

interface ParsedLlmRow {
  ts: string;        // ISO timestamp（audit.tsv col 0）
  success: boolean;  // llm_call = true, llm_error = false
  model: string;     // col 2
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  clawId: ClawId;    // 从文件路径推导
}

interface ModelStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMsTotal: number;
}

interface ClawStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmStatsSummary {
  date: string;                                   // 统计日期，如 "2026-03-27"
  generatedAt: string;                            // 生成时间 ISO
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;                           // 成功调用的平均延迟
  byModel: Record<string, ModelStats>;
  byClaw: Record<string, ClawStats>;
}

export interface LlmStatsOptions {
  motionDir: ClawDir;
  chestnutFs: FileSystem;   // baseDir = chestnutRoot
  motionFs: FileSystem;       // baseDir = motionDir
  audit: AuditLog;
  signal?: AbortSignal;
}

export interface LlmStatsJobDeps {
  motionDir: ClawDir;
  chestnutFs: FileSystem;
  motionFs: FileSystem;
  audit: AuditLog;
}

export async function runLlmStats(opts: LlmStatsOptions): Promise<void> {
  // 统计昨天的数据（UTC base，跨 TZ 一致）
  const yesterday = new Date(Date.now() - 86400000);
  const targetDate = yesterday.toISOString().slice(0, 10); // "YYYY-MM-DD"

  if (opts.signal?.aborted) return;
  const entries = collectEntries(opts, targetDate);
  if (entries.length === 0) {
    opts.audit.write(CRON_AUDIT_EVENTS.LLM_STATS, `step=empty_result`, `date=${targetDate}`);
    return;
  }

  const summary = aggregate(entries, targetDate, opts.signal);

  // 追加到 .chestnut/logs/llm-stats.jsonl
  opts.chestnutFs.ensureDirSync(path.dirname(LLM_STATS_FILE));
  const statsFile = LLM_STATS_FILE;
  opts.chestnutFs.appendSync(statsFile, JSON.stringify(summary) + '\n');

  opts.audit.write(CRON_AUDIT_EVENTS.LLM_STATS, `step=report`, `date=${targetDate}`, `totalCalls=${summary.totalCalls}`, `successCalls=${summary.successCalls}`, `failedCalls=${summary.failedCalls}`, `totalInputTokens=${summary.totalInputTokens}`, `totalOutputTokens=${summary.totalOutputTokens}`, `avg_latency_ms=${summary.avgLatencyMs}`);
}

function collectEntries(opts: LlmStatsOptions, targetDate: string): ParsedLlmRow[] {
  const results: ParsedLlmRow[] = [];

  const candidates: Array<{ fs: FileSystem; file: string; clawId: ClawId }> = [
    { fs: opts.motionFs, file: 'audit.tsv', clawId: MOTION_CLAW_ID },
    ...(() => {
      if (!opts.chestnutFs.existsSync(CLAWS_DIR)) return [];
      return opts.chestnutFs.listSync(CLAWS_DIR, { includeDirs: true }).map(e => ({
        fs: opts.chestnutFs,
        file: path.join(CLAWS_DIR, e.name, 'audit.tsv'),
        clawId: makeClawId(e.name),
      }));
    })(),
  ];

  for (const { fs, file, clawId } of candidates) {
    if (opts.signal?.aborted) return results;
    if (!fs.existsSync(file)) continue;
    const lines = fs.readSync(file).split('\n');
    for (const line of lines) {
      if (opts.signal?.aborted) return results;
      if (!line.trim()) continue;
      const cols = line.split('\t');
      const ts = cols[0] ?? '';
      let typeIdx = 1;
      if (cols[1]?.startsWith('seq=')) {
        typeIdx = 2;
      }
      const type = cols[typeIdx] ?? '';
      if (type !== 'llm_call' && type !== 'llm_error') continue;
      if (!ts.startsWith(targetDate)) continue;

      const kv = (key: string): number => {
        const col = cols.find(c => c.startsWith(`${key}=`));
        return col ? parseInt(col.slice(key.length + 1), 10) || 0 : 0;
      };

      results.push({
        ts,
        success: type === 'llm_call',
        model: cols[typeIdx + 1] ?? 'unknown',
        inputTokens: kv('in'),
        outputTokens: kv('out'),
        latencyMs: type === 'llm_call' ? kv('ms') : 0,
        clawId,
      });
    }
  }

  return results;
}

function aggregate(entries: ParsedLlmRow[], targetDate: string, signal?: AbortSignal): LlmStatsSummary {
  const byModel: Record<string, ModelStats> = {};
  const byClaw: Record<string, ClawStats> = {};

  let successCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const d of entries) {
    if (signal?.aborted) break;
    if (d.success) {
      successCalls++;
      latencySum += d.latencyMs;
      latencyCount++;
    }
    totalInputTokens += d.inputTokens ?? 0;
    totalOutputTokens += d.outputTokens ?? 0;

    // byModel
    const ms = byModel[d.model] ?? { calls: 0, inputTokens: 0, outputTokens: 0, latencyMsTotal: 0 };
    ms.calls++;
    ms.inputTokens += d.inputTokens ?? 0;
    ms.outputTokens += d.outputTokens ?? 0;
    ms.latencyMsTotal += d.latencyMs ?? 0;
    byModel[d.model] = ms;

    // byClaw
    const cs = byClaw[d.clawId] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    cs.calls++;
    cs.inputTokens += d.inputTokens ?? 0;
    cs.outputTokens += d.outputTokens ?? 0;
    byClaw[d.clawId] = cs;
  }

  return {
    date: targetDate,
    generatedAt: new Date().toISOString(),
    totalCalls: entries.length,
    successCalls,
    failedCalls: entries.length - successCalls,
    totalInputTokens,
    totalOutputTokens,
    avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
    byModel,
    byClaw,
  };
}

export function createLlmStatsJob(
  deps: LlmStatsJobDeps,
  globalConfig: ClawGlobalConfig,
): CronJob {
  return {
    name: 'llm-stats',
    enabled: globalConfig.cron.jobs.llm_stats.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.llm_stats.schedule, deps.audit),
    handler: (signal) => runLlmStats({ ...deps, signal }),
    timeoutMs: LLM_STATS_CRON_TIMEOUT_MS,
  };
}
