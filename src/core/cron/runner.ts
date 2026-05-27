/**
 * CronRunner — 轻量调度引擎
 * 独立 setInterval，与 daemon-loop 主循环解耦，支持秒级精度
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { isFileNotFound } from '../../foundation/fs/types.js';
import { CRON_AUDIT_EVENTS } from './audit-events.js';
import { CRON_TICK_INTERVAL_MS } from './constants.js';

export type CronSchedule =
  | { type: 'daily'; time: string }       // "HH:MM"，每天固定时刻
  | { type: 'hourly' }                     // 每小时整点
  | { type: 'interval'; ms: number };      // 每 N 毫秒（接收 s/m/h 单位、内部 ms 表示）

/** 将配置字符串解析为 CronSchedule
 * 格式：'hourly' | 'daily:HH:MM' | 'interval:N[smh]'
 *
 * 单位:
 * - 's' = seconds (`interval:30s` → ms=30_000)
 * - 'm' = minutes (`interval:5m` → ms=300_000)
 * - 'h' = hours (`interval:6h` → ms=21_600_000)
 *
 * phase 1216 (r131 B): suffix 严格 enforce、防 phase 793 起 silent drift 复发
 */
export function parseSchedule(s: string, audit?: AuditLog): CronSchedule | null {
  if (s === 'hourly') return { type: 'hourly' };
  if (s.startsWith('daily:')) {
    const [hh, mm] = s.slice(6).split(':').map(Number);
    if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      audit?.write(CRON_AUDIT_EVENTS.PARSE_INVALID, `input=${s}`, 'reason=invalid_daily_time');
      return null;
    }
    return { type: 'daily', time: s.slice(6) };
  }
  if (s.startsWith('interval:')) {
    const match = s.slice(9).match(/^(\d+)([smh])$/);
    if (!match) {
      audit?.write(CRON_AUDIT_EVENTS.PARSE_INVALID, `input=${s}`, 'reason=invalid_interval');
      return null;
    }
    const value = parseInt(match[1], 10);
    if (value <= 0) {
      audit?.write(CRON_AUDIT_EVENTS.PARSE_INVALID, `input=${s}`, 'reason=invalid_interval');
      return null;
    }
    const multiplier = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'];
    return { type: 'interval', ms: value * multiplier };
  }
  audit?.write(CRON_AUDIT_EVENTS.PARSE_FALLBACK, `input=${s}`, 'fallback=hourly');
  return { type: 'hourly' };
}

export interface CronJob {
  name: string;
  enabled: boolean;
  schedule: CronSchedule | null;
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
  // phase 1210: Map 替 Set 带 job tag（post-mortem 可分 job）
  private inflightPromises = new Map<Promise<unknown>, { job: string; runKey: string; startTs: number }>();
  // phase 946 (audit-2026-05-15 gap.7): AbortController for handler cooperative cancellation
  private abortController = new AbortController();
  // phase 1232 r132 C: per-job AbortController for真 abort on timeout / stuck
  private _activeAbortControllers = new Map<string, AbortController>();
  // F5: per-job initial scan guard to prevent daily double-fire on daemon restart
  private _initialScanDone = new Set<string>();
  // phase1109: cron state persistence (crash recovery for daily/hourly dedup)
  private stateFile = 'cron/state.json';

  constructor(
    private readonly jobs: CronJob[],
    private readonly audit: AuditLog,
    private readonly fs?: { read: (path: string, encoding: string) => Promise<string>; writeAtomic: (path: string, content: string) => Promise<void> },
  ) {}

  private async loadState(): Promise<void> {
    if (!this.fs) return;
    try {
      const raw = await this.fs.read(this.stateFile, 'utf-8');
      const state = JSON.parse(raw);
      if (Array.isArray(state.lastRunKeys)) {
        for (const [k, v] of state.lastRunKeys) this.lastRunKey.set(k, v);
      }
      if (Array.isArray(state.initialScanDone)) {
        for (const k of state.initialScanDone) this._initialScanDone.add(k);
      }
    } catch (e) {
      // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
      if (!isFileNotFound(e)) throw e;
    }
  }

  private async saveState(): Promise<void> {
    if (!this.fs) return;
    await this.fs.writeAtomic(this.stateFile, JSON.stringify({
      lastRunKeys: [...this.lastRunKey],
      initialScanDone: [...this._initialScanDone],
    }));
  }

  /** 启动调度器，tickIntervalMs 决定检查粒度（默认 1 秒） */
  start(tickIntervalMs = CRON_TICK_INTERVAL_MS): void {
    this.loadState().catch(() => { /* silent: non-critical state load, next tick retries */ });
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
    // phase 1232 r132 C: abort all per-job controllers on stop (shared 不替代 per-job)
    for (const [, ctrl] of this._activeAbortControllers) {
      ctrl.abort();
    }
    this._activeAbortControllers.clear();

    // drain inflight handlers
    if (this.inflightPromises.size > 0) {
      const drainPromise = Promise.allSettled([...this.inflightPromises.keys()]);
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve =>
        drainTimer = setTimeout(() => resolve('timeout'), drainTimeoutMs)
      );
      const winner = await Promise.race([drainPromise, timeoutPromise]);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      if (winner === 'timeout') {
        this.audit.write(
          CRON_AUDIT_EVENTS.RUNNER_DRAIN_TIMEOUT,
          `running=${[...this.running].join(',')}`,
          `timeout_ms=${drainTimeoutMs}`,
        );
        // Attach per-Promise late-settle audit on each remaining inflight
        // (phase 867 r111 E fork: Sc.1 post-drain late-settle observability)
        // Snapshot once — avoid concurrent delete from existing .then(_, _) cleanup
        const stuckSnapshot = new Map(this.inflightPromises);
        for (const [p, meta] of stuckSnapshot) {
          p.then(
            () => {
              this.audit.write(
                CRON_AUDIT_EVENTS.RUNNER_DRAIN_LATE_SETTLE,
                `job=${meta.job}`,
                `run_key=${meta.runKey}`,
                `outcome=settled`,
                `elapsed_ms=${Date.now() - meta.startTs}`,
              );
            },
            err => {
              this.audit.write(
                CRON_AUDIT_EVENTS.RUNNER_DRAIN_LATE_SETTLE,
                `job=${meta.job}`,
                `run_key=${meta.runKey}`,
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
        // phase 1232 r132 C: 再 abort (idempotent) + cleanup controller
        const ctrl = this._activeAbortControllers.get(name);
        if (ctrl) {
          ctrl.abort();  // idempotent if already aborted
          this.audit.write(
            CRON_AUDIT_EVENTS.HANDLER_ABORTED,
            `job=${name}`,
            `ticks=${ticks}`,
            'context=stuck_watchdog',
          );
          this._activeAbortControllers.delete(name);
        }
        this.cancelling.delete(name);
        this.cancellingTicks.delete(name);
      } else {
        this.cancellingTicks.set(name, ticks);
      }
    }
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (job.schedule === null) continue; // invalid schedule — skip registration (G3)
      if (this.running.has(job.name) || this.cancelling.has(job.name)) continue; // 上次还没跑完 或 cancelling 中，跳过
      // F5: daily first-tick guard — skip if daemon started before target time
      if (job.schedule.type === 'daily' && !this._initialScanDone.has(job.name)) {
        const [h, m] = job.schedule.time.split(':').map(Number);
        const targetMin = h * 60 + m;
        const nowMin = now.getHours() * 60 + now.getMinutes();
        this._initialScanDone.add(job.name);
        if (nowMin < targetMin) continue; // skip until target time
      }
      const key = this.computeRunKey(now, job.schedule);
      if (this.lastRunKey.get(job.name) === key) continue;
      this.lastRunKey.set(job.name, key);
      this.running.add(job.name);

      this.audit.write(CRON_AUDIT_EVENTS.JOB_STARTED, `job=${job.name}`, `run_key=${key}`);

      let handlerPromise: Promise<void>;
      try {
        const jobController = new AbortController();
        this._activeAbortControllers.set(job.name, jobController);
        handlerPromise = job.handler(jobController.signal);
      } catch (syncErr) {
        handlerPromise = Promise.reject(syncErr);
      }

      // phase 793 (P0.22): track inflight for stop drain
      this.inflightPromises.set(handlerPromise, { job: job.name, runKey: key, startTs: Date.now() });
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
          })
          .finally(() => {
            this.running.delete(job.name);
            this._activeAbortControllers.delete(job.name);
          });
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
          // phase 1232 r132 C: 真 abort handler signal (handler 若 cooperative respect 真 stop)
          const ctrl = this._activeAbortControllers.get(job.name);
          if (ctrl) {
            ctrl.abort();
            this.audit.write(
              CRON_AUDIT_EVENTS.HANDLER_ABORTED,
              `job=${job.name}`,
              `run_key=${key}`,
              'context=timeout',
            );
          }
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
            this._activeAbortControllers.delete(job.name);
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
            this._activeAbortControllers.delete(job.name);
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
          }
          // settled 或 err 路径：仅在未 timeout 时清 running
          if (!timedOut) {
            this.running.delete(job.name);
            this._activeAbortControllers.delete(job.name);
          }
        });
    }
    // Persist cron state after each tick (fire-and-forget, non-blocking)
    this.saveState().catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.audit.write(CRON_AUDIT_EVENTS.STATE_SAVE_FAILED, `reason=${reason}`);
    });
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
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const elapsedMs = now.getTime() - startOfDay.getTime();
        const block = Math.floor(elapsedMs / schedule.ms);
        return `${date}-${block}`;
      }
    }
  }
}
