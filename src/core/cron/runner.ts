/**
 * CronRunner — 轻量调度引擎
 * 独立 setInterval，与 daemon-loop 主循环解耦，支持秒级精度
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from './audit-events.js';
import { CRON_TICK_INTERVAL_MS } from './constants.js';

export type CronSchedule =
  | { type: 'daily'; time: string }       // "HH:MM"，每天固定时刻
  | { type: 'hourly' }                     // 每小时整点
  | { type: 'interval'; minutes: number }; // 每 N 分钟

/** 将配置字符串解析为 CronSchedule
 * 格式：'hourly' | 'daily:HH:MM' | 'interval:Nm'
 */
export function parseSchedule(s: string, audit?: AuditLog): CronSchedule {
  if (s === 'hourly') return { type: 'hourly' };
  if (s.startsWith('daily:')) return { type: 'daily', time: s.slice(6) };
  if (s.startsWith('interval:')) {
    const minutes = parseInt(s.slice(9), 10);
    return { type: 'interval', minutes };
  }
  audit?.write(CRON_AUDIT_EVENTS.PARSE_FALLBACK, `input=${s}`, 'fallback=hourly');
  console.warn(`[cron] Unknown schedule format "${s}", falling back to hourly`);
  return { type: 'hourly' };
}

export interface CronJob {
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  handler: (signal?: AbortSignal) => Promise<void>;
  /** Per-job timeout: handler 超过此值后 audit + 强制清 running 让下 tick 重试 / undefined 不包 race / 兼容旧 jobs */
  timeoutMs?: number;
}

const CANCELLING_STUCK_TICKS = 10; // timeout 后 N ticks 仍 cancelling 视为 handler 永挂

export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunKey = new Map<string, string>(); // jobName → runKey
  private running = new Set<string>();            // 防止同一 job 重叠执行
  private cancelling = new Set<string>();         // timeout 已发但 handler 真 settle 前的二态
  private cancellingTicks = new Map<string, number>(); // job → tick 计数（cancelling 期间）
  // phase 793 (audit-2026-05-14 P0.22): inflight Promise tracking 加 stop 时 drain
  // 防 cronRunner.stop 后 dream-trigger 30min handler 撞 runtime.stop 的 llm.close
  private inflightPromises = new Set<Promise<unknown>>();
  // phase 867 (r111 E fork): runner-level flag — drain timeout 后 set、future extension scope
  private drainTimedOut = false;
  // phase 946 (audit-2026-05-15 gap.7): AbortController for handler cooperative cancellation
  private abortController = new AbortController();

  constructor(
    private readonly jobs: CronJob[],
    private readonly audit: AuditLog,
  ) {}

  /** 启动调度器，tickIntervalMs 决定检查粒度（默认 1 秒） */
  start(tickIntervalMs = CRON_TICK_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tickIntervalMs);
    this.audit.write(CRON_AUDIT_EVENTS.RUNNER_STARTED, `jobs=${this.jobs.length}`);
  }

  // phase 793: sync → async + drain inflight handlers with cap timeout 30s
  // mirror runtime.stop 的 taskSystem.shutdown(30_000) cap 一致
  async stop(drainTimeoutMs = 30_000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // phase 946: signal handler cooperative abort (LLM call → fetch early reject)
    // 在 drain 之前 abort、让 inflight handler 尽快 settle / drain 实际 < cap timeout
    this.abortController.abort();

    // drain inflight handlers
    if (this.inflightPromises.size > 0) {
      const drainPromise = Promise.allSettled([...this.inflightPromises]);
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve =>
        drainTimer = setTimeout(() => resolve('timeout'), drainTimeoutMs)
      );
      const winner = await Promise.race([drainPromise, timeoutPromise]);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      if (winner === 'timeout') {
        this.drainTimedOut = true;
        this.audit.write(
          CRON_AUDIT_EVENTS.RUNNER_DRAIN_TIMEOUT,
          `running=${[...this.running].join(',')}`,
          `timeout_ms=${drainTimeoutMs}`,
        );
        // Attach per-Promise late-settle audit on each remaining inflight
        // (phase 867 r111 E fork: Sc.1 post-drain late-settle observability)
        // Snapshot once — avoid concurrent delete from existing .then(_, _) cleanup
        const stuckSnapshot = new Set(this.inflightPromises);
        for (const p of stuckSnapshot) {
          p.then(
            () => {
              this.audit.write(
                CRON_AUDIT_EVENTS.RUNNER_DRAIN_LATE_SETTLE,
                `outcome=settled`,
              );
            },
            err => {
              this.audit.write(
                CRON_AUDIT_EVENTS.RUNNER_DRAIN_LATE_SETTLE,
                `outcome=err`,
                `error=${err instanceof Error ? err.message : String(err)}`,
              );
            },
          );
        }
      }
    }

    this.audit.write(CRON_AUDIT_EVENTS.RUNNER_STOPPED, `jobs=${this.jobs.length}`);
  }

  /** 供测试用：手动触发一次检查 */
  tick(): void {
    const now = new Date();
    // P1.14 stuck watchdog：cancelling 中 job tick 计数 / 阈值后 audit + 强清 cancelling 让下 tick 自然重试（D1c 中断可恢复 + handler 幂等假设）
    for (const name of this.cancelling) {
      const ticks = (this.cancellingTicks.get(name) ?? 0) + 1;
      if (ticks >= CANCELLING_STUCK_TICKS) {
        const job = this.jobs.find(j => j.name === name);
        this.audit.write(CRON_AUDIT_EVENTS.HANDLER_STUCK,
          `job=${name}`,
          `ticks=${ticks}`,
          `timeout_ms=${job?.timeoutMs ?? 'unknown'}`,
        );
        this.cancelling.delete(name);
        this.cancellingTicks.delete(name);
      } else {
        this.cancellingTicks.set(name, ticks);
      }
    }
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (this.running.has(job.name) || this.cancelling.has(job.name)) continue; // 上次还没跑完 或 cancelling 中，跳过
      const key = this.computeRunKey(now, job.schedule);
      if (this.lastRunKey.get(job.name) === key) continue;
      this.lastRunKey.set(job.name, key);
      this.running.add(job.name);

      let handlerPromise: Promise<void>;
      try {
        handlerPromise = job.handler(this.abortController.signal);
      } catch (syncErr) {
        handlerPromise = Promise.reject(syncErr);
      }

      // phase 793 (P0.22): track inflight for stop drain
      this.inflightPromises.add(handlerPromise);
      handlerPromise.then(
        () => { this.inflightPromises.delete(handlerPromise); },
        () => { this.inflightPromises.delete(handlerPromise); },
      );

      if (job.timeoutMs === undefined) {
        // 无 timeout 配置：保持原行为（兼容旧 job）
        handlerPromise
          .catch(err => {
            this.audit.write(CRON_AUDIT_EVENTS.JOB_ERROR,
              `job=${job.name}`,
              `run_key=${key}`,
              `error=${err instanceof Error ? err.message : String(err)}`,
            );
            console.error(`[cron] ${job.name} error:`, err);
          })
          .finally(() => this.running.delete(job.name));
        continue;
      }

      // 有 timeout 配置：Promise.race + 强制清 running
      let timedOut = false;
      let timeoutFiredAt = 0;  // NEW phase 758
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          timeoutFiredAt = Date.now();  // NEW phase 758
          this.audit.write(CRON_AUDIT_EVENTS.HANDLER_TIMEOUT,
            `job=${job.name}`,
            `run_key=${key}`,
            `timeout_ms=${job.timeoutMs}`,
          );
          // timeout 时强制清 running + 置 cancelling / 让下 tick 自然重试（D1c 中断可恢复 + handler 幂等假设）
          this.running.delete(job.name);
          this.cancelling.add(job.name);
          this.cancellingTicks.set(job.name, 0);
          resolve();
        }, job.timeoutMs);
      });

      // 独立钩子：late settle 清 cancelling / late error 必 audit（context=late_after_timeout / ζ 复用 JOB_ERROR）
      handlerPromise.then(
        () => {
          if (timedOut) {
            this.audit.write(  // NEW phase 758
              CRON_AUDIT_EVENTS.JOB_LATE_SETTLED,
              `job=${job.name}`,
              `run_key=${key}`,
              `late_settle_ms=${Date.now() - timeoutFiredAt}`,
            );
            this.cancelling.delete(job.name);
            this.cancellingTicks.delete(job.name);
          }
        },
        err => {
          if (timedOut) {
            this.audit.write(CRON_AUDIT_EVENTS.JOB_ERROR,
              `job=${job.name}`,
              `run_key=${key}`,
              `error=${err instanceof Error ? err.message : String(err)}`,
              'context=late_after_timeout',
            );
            this.cancelling.delete(job.name);
            this.cancellingTicks.delete(job.name);
          }
          // 非 timedOut 时 race chain 路径已 audit JOB_ERROR / 此处不重 audit
        }
      );

      Promise.race([
        handlerPromise.then(() => 'settled' as const, err => ({ err })),
        timeoutPromise.then(() => 'timeout' as const),
      ])
        .then(result => {
          if (timer !== undefined) clearTimeout(timer);
          if (result === 'timeout') return; // running 已在 timeout 内清 / handler 仍跑（异步泄漏可接受 / 见 R2）
          if (typeof result === 'object' && 'err' in result) {
            this.audit.write(CRON_AUDIT_EVENTS.JOB_ERROR,
              `job=${job.name}`,
              `run_key=${key}`,
              `error=${result.err instanceof Error ? result.err.message : String(result.err)}`,
            );
            console.error(`[cron] ${job.name} error:`, result.err);
          }
          // settled 或 err 路径：仅在未 timeout 时清 running
          if (!timedOut) this.running.delete(job.name);
        });
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
