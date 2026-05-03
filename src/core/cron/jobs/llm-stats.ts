import * as path from 'path';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import { LOGS_DIR } from '../../../types/paths.js';

interface ParsedLlmRow {
  ts: string;        // ISO timestamp（audit.tsv col 0）
  success: boolean;  // llm_call = true, llm_error = false
  model: string;     // col 2
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  clawId: string;    // 从文件路径推导
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
  clawforumDir: string;
  motionDir: string;
  clawforumFs: FileSystem;   // baseDir = clawforumDir
  motionFs: FileSystem;       // baseDir = motionDir
  audit: AuditLog;
}

export async function runLlmStats(opts: LlmStatsOptions): Promise<void> {
  // 统计昨天的数据
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const targetDate = yesterday.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const entries = collectEntries(opts, targetDate);
  if (entries.length === 0) {
    opts.audit.write(CRON_AUDIT_EVENTS.LLM_STATS, `step=empty_result`, `date=${targetDate}`);
    console.log(`[cron:llm-stats] No LLM calls found for ${targetDate}`);
    return;
  }

  const summary = aggregate(entries, targetDate);

  // 追加到 .clawforum/logs/llm-stats.jsonl
  opts.clawforumFs.ensureDirSync(LOGS_DIR);
  const statsFile = path.join(LOGS_DIR, 'llm-stats.jsonl');
  opts.clawforumFs.appendSync(statsFile, JSON.stringify(summary) + '\n');

  opts.audit.write(CRON_AUDIT_EVENTS.LLM_STATS, `step=report`, `date=${targetDate}`, `totalCalls=${summary.totalCalls}`, `successCalls=${summary.successCalls}`, `failedCalls=${summary.failedCalls}`, `totalInputTokens=${summary.totalInputTokens}`, `totalOutputTokens=${summary.totalOutputTokens}`, `avgLatencyMs=${summary.avgLatencyMs}`);
  console.log(
    `[cron:llm-stats] ${targetDate}: ${summary.totalCalls} calls, ` +
    `${summary.totalInputTokens}/${summary.totalOutputTokens} tokens in/out, ` +
    `${summary.failedCalls} failed`
  );
}

function collectEntries(opts: LlmStatsOptions, targetDate: string): ParsedLlmRow[] {
  const results: ParsedLlmRow[] = [];

  const candidates: Array<{ fs: FileSystem; file: string; clawId: string }> = [
    { fs: opts.motionFs, file: 'audit.tsv', clawId: 'motion' },
    ...(() => {
      if (!opts.clawforumFs.existsSync('claws')) return [];
      return opts.clawforumFs.listSync('claws', { includeDirs: true }).map(e => ({
        fs: opts.clawforumFs,
        file: path.join('claws', e.name, 'audit.tsv'),
        clawId: e.name,
      }));
    })(),
  ];

  for (const { fs, file, clawId } of candidates) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readSync(file).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      const ts = cols[0] ?? '';
      const type = cols[1] ?? '';
      if (type !== 'llm_call' && type !== 'llm_error') continue;
      if (!ts.startsWith(targetDate)) continue;

      const kv = (key: string): number => {
        const col = cols.find(c => c.startsWith(`${key}=`));
        return col ? parseInt(col.slice(key.length + 1), 10) || 0 : 0;
      };

      results.push({
        ts,
        success: type === 'llm_call',
        model: cols[2] ?? 'unknown',
        inputTokens: kv('in'),
        outputTokens: kv('out'),
        latencyMs: type === 'llm_call' ? kv('ms') : 0,
        clawId,
      });
    }
  }

  return results;
}

function aggregate(entries: ParsedLlmRow[], targetDate: string): LlmStatsSummary {
  const byModel: Record<string, ModelStats> = {};
  const byClaw: Record<string, ClawStats> = {};

  let successCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const d of entries) {
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
