/**
 * handler invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - handler-sync-throw.test.ts
 *  - handler-signal-cascade-invariant.test.ts
 *  - handler-real-abort.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronRunner } from '../../../src/foundation/cron/runner.js';
import type { CronJob } from '../../../src/foundation/cron/runner.js';
import { CRON_AUDIT_EVENTS } from '../../../src/foundation/cron/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

describe('handler-sync-throw', () => {
  function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
    return { write: vi.fn() };
  }

  describe('CronRunner handler sync throw', () => {
    let audit: { write: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.useFakeTimers({ now: new Date(2026, 3, 21, 10, 30, 0) });
      audit = makeMockAudit();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('handler sync throw 自动转 reject + audit JOB_ERROR + running 清空', async () => {
      const handler = vi.fn(() => {
        throw new Error('sync');
      });
      const job: CronJob = {
        name: 'sync-throw',
        enabled: true,
        schedule: { type: 'hourly' },
        handler,
      };
      const runner = new CronRunner([job], audit as unknown as AuditLog);

      runner.tick();
      await Promise.resolve();
      await vi.runAllTicks();

      expect(audit.write).toHaveBeenCalledWith(
        CRON_AUDIT_EVENTS.JOB_ERROR,
        'job=sync-throw',
        expect.stringContaining('run_key='),
        'error=sync',
      );

      expect((runner as unknown as { running: Set<string> }).running.has('sync-throw')).toBe(false);
    });
  });
});

describe('handler-signal-cascade-invariant', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '../../..');

  /**
   * cron handler signal cascade invariant (phase 1266 r135 B fork)
   *
   * #1 NEW handler arrow without signal param ratchet 已迁 ESLint custom rule
   * `chestnut-custom/no-cron-handler-without-signal` (phase 423).
   *
   * 本 file 仅留 positive presence checks #2 + #3:
   *   #2 runXxx fn opts interface contains `signal?: AbortSignal`
   *   #3 dream-trigger handler wires signal
   */
  describe('cron handler signal cascade positive checks (phase 423 缩 vitest)', () => {
    it('all cron jobs runXxx fn must accept signal in opts type', () => {
      // phase 697 Step A: cron 物理迁 src/core/cron/ → src/foundation/cron/
      const jobsDir = path.join(repoRoot, 'src', 'foundation', 'cron', 'jobs');
      const contractJobsDir = path.join(repoRoot, 'src', 'core', 'contract', 'jobs');

      const jobFiles = [
        ...(existsSync(jobsDir) ? readdirSync(jobsDir) : [])
          .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
          .map(f => path.join(jobsDir, f)),
        ...readdirSync(contractJobsDir)
          .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
          .map(f => path.join(contractJobsDir, f)),
      ];

      const violations: string[] = [];

      for (const filePath of jobFiles) {
        const src = readFileSync(filePath, 'utf-8');
        const fileName = path.basename(filePath);

        // Skip files that don't export a runXxx function or Options interface
        const hasRunFn = /export\s+(async\s+)?function\s+run\w+\s*\(/.test(src);
        if (!hasRunFn) continue;

        // Check that the Options interface contains signal?: AbortSignal
        if (!/signal\?\s*:\s*AbortSignal/.test(src)) {
          violations.push(fileName);
        }
      }

      expect(
        violations,
        `Missing signal?: AbortSignal in opts interface for: ${violations.join(', ')}`,
      ).toEqual([]);
    });

    it('反向 3: dream-trigger cooperative invariant (already wire signal)', () => {
      const dreamTriggerPath = path.join(repoRoot, 'src', 'core', 'memory', 'jobs', 'dream-trigger.ts');
      const src = readFileSync(dreamTriggerPath, 'utf-8');

      // Dream-trigger must remain cooperative with async (signal) =>
      const dreamTriggerMatch = src.match(
        /handler:\s*async\s*\(\s*signal\s*\)\s*=>/,
      );
      expect(dreamTriggerMatch, 'dream-trigger handler must wire signal param').toBeTruthy();
    });
  });
});

describe('handler-real-abort', () => {
  /**
   * Phase 1232 r132 C: per-job AbortController + 真 abort verify
   *
   * 反向证明：
   *   1. timeout 触发后 controller.abort() 真 fire (signal.aborted === true)
   *   2. stuck watchdog 路径再次 abort idempotent + cleanup controller map
   *   3. late settle 后 controller map 清干净 (no leak)
   *   4. normal complete 后 controller map 也清干净
   */

  /**
   * Promise barrier releases for mock handler delays under fake timers.
   * Released explicitly by tests, removing wall-clock dependency.
   */
  let overTimeoutRelease: (() => void) | undefined;
  let fastHandlerRelease: (() => void) | undefined;

  function makeMockAudit() {
    const events: Array<[string, ...string[]]> = [];
    return {
      write: vi.fn((type: string, ...cols: string[]) => events.push([type, ...cols])),
      events,
    };
  }

  describe('cron handler real abort (phase 1232 r132 C)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: new Date(2026, 5, 25, 10, 0, 0) });
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    // 反向 1: timeout 后 signal.aborted === true + audit HANDLER_ABORTED context=timeout
    it('timeout 路径真 abort signal + audit HANDLER_ABORTED context=timeout', async () => {
      const audit = makeMockAudit();
      let capturedSignal: AbortSignal | undefined;
      const job: CronJob = {
        name: 'slow-job',
        enabled: true,
        schedule: { type: 'hourly' },
        timeoutMs: 50,
        handler: async (signal?: AbortSignal) => {
          capturedSignal = signal;
          await new Promise<void>(r => { overTimeoutRelease = r; });  // barrier: outlive timeoutMs
        },
      };
      const runner = new CronRunner([job], audit as any);
      runner.tick();
      await vi.advanceTimersByTimeAsync(100);  // 等 timeout fire
      expect(capturedSignal?.aborted).toBe(true);
      overTimeoutRelease!();
      expect(
        audit.events.find(
          e => e[0] === CRON_AUDIT_EVENTS.HANDLER_ABORTED && e.some(c => c.includes('context=timeout'))
        )
      ).toBeDefined();
      runner.stop();
    });

    // 反向 2: Phase 1073 stuck watchdog 只 audit HANDLER_STUCK，不改变互斥状态、不清理 controller
    it('stuck watchdog 路径 audit HANDLER_STUCK + 标记 degraded + 不释放 controller', async () => {
      const audit = makeMockAudit();
      const job: CronJob = {
        name: 'stuck-job',
        enabled: true,
        schedule: { type: 'hourly' },
        timeoutMs: 10,
        handler: async () => new Promise(() => {}),  // 永不 settle
      };
      const runner = new CronRunner([job], audit as any);
      runner.tick();
      // 等 timeout fire
      await vi.advanceTimersByTimeAsync(100);
      // 模拟 10+ ticks stuck 后 watchdog
      for (let i = 0; i < 12; i++) runner.tick();
      const stuckEvents = audit.events.filter(
        e => e[0] === CRON_AUDIT_EVENTS.HANDLER_STUCK
      );
      expect(stuckEvents.length).toBe(1);
      expect(stuckEvents[0]).toContain('job=stuck-job');
      // Phase 1073: 标记 degraded，controller/cancelling 仍持有直到 handler 真实 settle
      expect((runner as any).stuckJobs.has('stuck-job')).toBe(true);
      expect((runner as any)._activeAbortControllers.has('stuck-job')).toBe(true);
      expect((runner as any).cancelling.has('stuck-job')).toBe(true);
      runner.stop();
    });

    // 反向 3: late settle 后 controller map 清干净
    it('late settle 路径 controller cleanup (no leak)', async () => {
      const audit = makeMockAudit();
      let resolveHandler: () => void = () => {};
      const job: CronJob = {
        name: 'late-job',
        enabled: true,
        schedule: { type: 'hourly' },
        timeoutMs: 10,
        handler: () => new Promise<void>(r => { resolveHandler = r; }),
      };
      const runner = new CronRunner([job], audit as any);
      runner.tick();
      await vi.advanceTimersByTimeAsync(100);  // timeout fire
      resolveHandler();  // late settle
      await vi.advanceTimersByTimeAsync(50);
      // controller map, cancelling, cancellingTicks all cleaned
      expect((runner as any)._activeAbortControllers.has('late-job')).toBe(false);
      expect((runner as any).cancelling.has('late-job')).toBe(false);
      expect((runner as any).cancellingTicks.has('late-job')).toBe(false);
      // 强制 re-fire（hourly schedule 同 key 不重触发 / 手动清 lastRunKey 验证 reschedulable）
      (runner as any).lastRunKey.delete('late-job');
      runner.tick();
      expect((runner as any).running.has('late-job')).toBe(true);
      runner.stop();
    });

    // 反向 4: normal complete 后 controller map 清干净
    it('normal complete 路径 controller cleanup (no leak)', async () => {
      const audit = makeMockAudit();
      let handlerRan = false;
      const job: CronJob = {
        name: 'fast-job',
        enabled: true,
        schedule: { type: 'hourly' },
        handler: async () => {
          handlerRan = true;
          await new Promise<void>(r => { fastHandlerRelease = r; });
        },
      };
      const runner = new CronRunner([job], audit as any);
      runner.tick();
      fastHandlerRelease!();
      await vi.advanceTimersByTimeAsync(50);  // 等 handler 完成
      expect(handlerRan).toBe(true);
      expect((runner as any)._activeAbortControllers.has('fast-job')).toBe(false);
      expect((runner as any).running.has('fast-job')).toBe(false);
      runner.stop();
    });
  });
});
