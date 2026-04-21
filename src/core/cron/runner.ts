/**
 * CronRunner — 轻量调度引擎
 * 独立 setInterval，与 daemon-loop 主循环解耦，支持秒级精度
 */

import type { Audit } from '../../foundation/audit/index.js';

export type CronSchedule =
  | { type: 'daily'; time: string }       // "HH:MM"，每天固定时刻
  | { type: 'hourly' }                     // 每小时整点
  | { type: 'interval'; minutes: number }; // 每 N 分钟

/** 将配置字符串解析为 CronSchedule
 * 格式：'hourly' | 'daily:HH:MM' | 'interval:Nm'
 */
export function parseSchedule(s: string, audit?: Audit): CronSchedule {
  if (s === 'hourly') return { type: 'hourly' };
  if (s.startsWith('daily:')) return { type: 'daily', time: s.slice(6) };
  if (s.startsWith('interval:')) {
    const minutes = parseInt(s.slice(9), 10);
    return { type: 'interval', minutes };
  }
  audit?.write('cron_parse_fallback', `input=${s}`, 'fallback=hourly');
  console.warn(`[cron] Unknown schedule format "${s}", falling back to hourly`);
  return { type: 'hourly' };
}

export interface CronJob {
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  handler: () => Promise<void>;
}

export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunKey = new Map<string, string>(); // jobName → runKey
  private running = new Set<string>();            // 防止同一 job 重叠执行

  constructor(
    private readonly jobs: CronJob[],
    private readonly audit: Audit,
  ) {}

  /** 启动调度器，tickIntervalMs 决定检查粒度（默认 1 秒） */
  start(tickIntervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 供测试用：手动触发一次检查 */
  tick(): void {
    const now = new Date();
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (this.running.has(job.name)) continue; // 上次还没跑完，跳过
      const key = this.computeRunKey(now, job.schedule);
      if (this.lastRunKey.get(job.name) === key) continue;
      this.lastRunKey.set(job.name, key);
      this.running.add(job.name);
      job.handler()
        .catch(err => {
          this.audit.write('cron_job_error',
            `job=${job.name}`,
            `run_key=${key}`,
            `err=${err instanceof Error ? err.message : String(err)}`,
          );
          console.error(`[cron] ${job.name} error:`, err);
        })
        .finally(() => this.running.delete(job.name));
    }
  }

  private computeRunKey(now: Date, schedule: CronSchedule): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    switch (schedule.type) {
      case 'daily': {
        const [h, m] = schedule.time.split(':').map(Number);
        // 当前时间 >= 目标时刻 → 今日 key；否则 pending
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const targetMin = h * 60 + m;
        return nowMin >= targetMin ? date : `${date}-pending`;
      }
      case 'hourly':
        return `${date}T${pad(now.getHours())}`;
      case 'interval': {
        const block = Math.floor(
          (now.getHours() * 60 + now.getMinutes()) / schedule.minutes
        );
        return `${date}-${block}`;
      }
    }
  }
}
