/**
 * CronRunner — 轻量调度引擎
 * 独立 setInterval，与 daemon-loop 主循环解耦，支持秒级精度
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import { CRON_AUDIT_EVENTS } from './audit-events.js';
import { CRON_TICK_INTERVAL_MS } from './constants.js';

export type CronSchedule =
  | { type: 'daily'; time: string }       // "HH:MM"，每天固定时刻
  | { type: 'hourly' }                     // 每小时整点
  | { type: 'interval'; ms: number };      // 每 N 毫秒（接收 s/m/h 单位、内部 ms 表示）

type ParseScheduleResult =
  | { ok: true; schedule: CronSchedule }
  | { ok: false; reason: 'invalid_daily_time' | 'invalid_interval' | 'fallback_hourly' };

/** 纯解析、0 audit 副作用。
 * 格式：'hourly' | 'daily:HH:MM' | 'interval:N[smh]'
 *
 * 单位:
 * - 's' = seconds (`interval:30s` → ms=30_000)
 * - 'm' = minutes (`interval:5m` → ms=300_000)
 * - 'h' = hours (`interval:6h` → ms=21_600_000)
 *
 * phase 1216 (r131 B): suffix 严格 enforce、防 phase 793 起 silent drift 复发
 * Phase 28 Step C: 拆 audit 到 thin wrapper (parseSchedule)
 */
export function parseScheduleRaw(s: string): ParseScheduleResult {
  if (s === 'hourly') return { ok: true, schedule: { type: 'hourly' } };
  if (s.startsWith('daily:')) {
    const [hh, mm] = s.slice(6).split(':').map(Number);
    if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return { ok: false, reason: 'invalid_daily_time' };
    }
    return { ok: true, schedule: { type: 'daily', time: s.slice(6) } };
  }
  if (s.startsWith('interval:')) {
    const match = s.slice(9).match(/^(\d+)([smh])$/);
    if (!match) {
      return { ok: false, reason: 'invalid_interval' };
    }
    const value = parseInt(match[1], 10);
    if (value <= 0) {
      return { ok: false, reason: 'invalid_interval' };
    }
    const multiplier = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'];
    return { ok: true, schedule: { type: 'interval', ms: value * multiplier } };
  }
  return { ok: false, reason: 'fallback_hourly' };
}

/** 将配置字符串解析为 CronSchedule（backward-compat thin wrapper，含 audit）。
 * 新代码优先用 parseScheduleRaw 以获得纯解析语义。
 */
export function parseSchedule(s: string, audit?: AuditLog): CronSchedule | null {
  const r = parseScheduleRaw(s);
  if (r.ok) return r.schedule;
  switch (r.reason) {
    case 'invalid_daily_time':
    case 'invalid_interval':
      audit?.write(CRON_AUDIT_EVENTS.PARSE_INVALID, `input=${s}`, `reason=${r.reason}`);
      return null;
    case 'fallback_hourly':
      audit?.write(CRON_AUDIT_EVENTS.PARSE_FALLBACK, `input=${s}`, 'fallback=hourly');
      return { type: 'hourly' };
    default: {
      const _exhaustive: never = r.reason;
      return _exhaustive;
    }
  }
}

export interface CronJob {
  name: string;
  enabled: boolean;
  schedule: CronSchedule | null;
  handler: (signal?: AbortSignal) => Promise<void>;
  /** Per-job timeout: handler 超过此值后 audit + 强制清 running 让下 tick 重试 / undefined 不包 race / 兼容旧 jobs */
  timeoutMs?: number;
}

/** Narrow config slice used by cron job factories; avoids L5 → L6 reverse type import. */
export interface CronJobGlobalConfig<JobName extends string> {
  cron: {
    jobs: Record<JobName, { enabled: boolean; schedule: string }>;
  };
}

/**
 * Cron handler timeout 后视为 stuck 的 tick 阈值.
 * Derivation: timeout 后 10 ticks（≈ 10s @ 1s cron tick）仍 cancelling 视为 handler 永挂;
 * 触发 fail-loud audit + 释 inflight slot 给后续 schedule.
 * 配 CRON_TICK_INTERVAL_MS=1000、总 stuck detection budget = CANCELLING_STUCK_TICKS × tick_ms ≈ 10s.
 */
const CANCELLING_STUCK_TICKS = 10;

/**
 * Cron 调度器、**stateless** 设计（D4 显式豁免、详 `design/modules/l5_cron.md §4`）。
 *
 * 所有运行时状态（`lastRunKey`、`running`、`cancelling`、`cancellingTicks`、
 * `inflightPromises`、`_initialScanDone` 等）在**进程内存**、**0 磁盘 artifact**。
 *
 * Daemon 重启行为：
 * - `lastRunKey` 重置 → 重启时刻跨 daily 目标的 job 会重新触发（去重靠新累积 lastRunKey）
 * - `_initialScanDone` 重置 → F5 startup-scan guard 仅在进程生命周期内有效
 *
 * **Handler 必须 idempotent 的契约**：cross-restart 安全靠 handler 自身幂等性
 * + 各 job 自治 cooldown（如 dream `.random-dream-state.json`、`.deep-dream-state.json`）
 * 兜底。框架不在 runner 层提供 cross-restart dedup。
 *
 * D4 豁免理由（详 design）：(a) jobs 设计为幂等 (b) cron 重启场景罕见
 * (c) 落盘 lastRunKey 引入 fs 依赖收益不抵成本。
 */
export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** phase 545: 防 stop 二次调用重 drain 30s（与 Runtime._stopped phase 522 同模式）*/
  private _stopped = false;
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
  // Phase 1073: cancelling 期间超过 stuck 阈值仍未 settle 的 job 标记为 degraded，
  // 在 handler 真实 settle 后仍阻塞同名后续调度，防止并发写相同资源。
  private stuckJobs = new Set<string>();

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
    // phase 545: 幂等 guard、防 stop 二次调用重 drain
    if (this._stopped) return;
    this._stopped = true;
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
                `error=${formatErr(err)}`,
              );
            },
          );
        }
      }
    }

    this.audit.write(CRON_AUDIT_EVENTS.RUNNER_STOPPED, `jobs=${this.jobs.length}`);
  }

  /**
   * @internal Test entry + production setInterval 内部调用入口；外部 caller 不应直接调用。
   * 供测试用：手动触发一次检查（test 模拟 setInterval tick）
   */
  tick(): void {
    const now = new Date();
    // Phase 1073: cancelling 中 job tick 计数仅用于 stuck 检测 + audit。
    // 关键：cancelling 不再因 tick 计数被删除；只有 handler Promise 真实 settle
    // （fulfilled 或 rejected）后，settle 回调才会清理 cancelling。在 settle 前，
    // 同名 job 因 cancelling.has(job) 被跳过，避免旧 handler 与新 handler 并发。
    for (const name of this.cancelling) {
      const ticks = (this.cancellingTicks.get(name) ?? 0) + 1;
      this.cancellingTicks.set(name, ticks);
      if (ticks >= CANCELLING_STUCK_TICKS && !this.stuckJobs.has(name)) {
        const job = this.jobs.find(j => j.name === name);
        this.audit.write(CRON_AUDIT_EVENTS.HANDLER_STUCK,
          `job=${name}`,
          `ticks=${ticks}`,
          `timeout_ms=${job?.timeoutMs ?? 'unknown'}`,
        );
        this.stuckJobs.add(name);
      }
    }
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (job.schedule === null) continue; // invalid schedule — skip registration (G3)
      if (this.running.has(job.name) || this.cancelling.has(job.name) || this.stuckJobs.has(job.name)) continue; // 上次还没跑完 / cancelling 中 / 已 degraded，跳过
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
              `error=${formatErr(err)}`,
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
              `error=${formatErr(err)}`,
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
              `error=${formatErr(result.err)}`,
            );
          }
          // settled 或 err 路径：仅在未 timeout 时清 running
          if (!timedOut) {
            this.running.delete(job.name);
            this._activeAbortControllers.delete(job.name);
          }
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
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const elapsedMs = now.getTime() - startOfDay.getTime();
        const block = Math.floor(elapsedMs / schedule.ms);
        return `${date}-${block}`;
      }
      default: {
        // phase 364 D1 (review-2026-06-13): exhaustive 守 CronSchedule variant
        const _exhaustive: never = schedule;
        throw new Error(`computeRunKey: unhandled CronSchedule variant: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
