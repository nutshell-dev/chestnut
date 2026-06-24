/**
 * phase 1489: 提取 SubAgent.run() 内嵌的「超时控制 + idle 计时 + 外部 signal 桥接」三合一编排。
 * derive M#1 — 超时策略与流回调 / 错误分类是独立可变方向。
 *
 * 行为契约（必与原 agent.ts 等价、tests/core/subagent.test.ts + task-subagent.test.ts 守）：
 * - timeoutMs 到点 → AbortController.abort({ type: 'turn_timeout', ms }) → timeoutPromise reject(ToolTimeoutError)
 * - idleTimeoutMs 到点 → onIdleTimeout?.() (silent if throws) → abort({ type: 'idle_timeout', ms })
 * - externalSignal abort → abort(externalSignal.reason)
 * - timeoutPromise 落地时 auditWriter emit SUBAGENT_AUDIT_EVENTS.TIMEOUT_REJECTION
 * - cleanup() 清两个 timer + remove external signal listener (idempotent)
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import { ToolTimeoutError } from '../../foundation/tools/errors.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../signals.js';
import type { AbortReason } from '../../foundation/llm-provider/index.js';
import { makeExternalAbortError } from '../../foundation/llm-provider/index.js';
import { SUBAGENT_AUDIT_EVENTS } from './audit-events.js';

export interface TimeoutControllerOptions {
  timeoutMs: number;
  idleTimeoutMs?: number;
  onIdleTimeout?: () => void;
  externalSignal?: AbortSignal;
  auditWriter: AuditLog;
  agentId: string;
}

export interface TimeoutControllerHandle {
  signal: AbortSignal;
  timeoutPromise: Promise<never>;
  resetIdle?: () => void;
  cleanup: () => void;
}

export function createTimeoutController(opts: TimeoutControllerOptions): TimeoutControllerHandle {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort({ type: 'turn_timeout', ms: opts.timeoutMs } satisfies AbortReason);
  }, opts.timeoutMs);

  let idleTimerId: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = opts.idleTimeoutMs
    ? () => {
        clearTimeout(idleTimerId);
        idleTimerId = setTimeout(() => {
          try {
            opts.onIdleTimeout?.();
          } catch { /* silent: callback failure must not block abort */ }
          controller.abort({ type: 'idle_timeout', ms: opts.idleTimeoutMs! } satisfies AbortReason);
        }, opts.idleTimeoutMs!);
      }
    : undefined;

  const onExternalAbort = () => {
    controller.abort(opts.externalSignal!.reason);
  };
  if (opts.externalSignal) {
    opts.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      const r = controller.signal.reason as AbortReason | undefined;
      if (r?.type === 'turn_timeout') {
        reject(new ToolTimeoutError('subagent_run', r.ms));
      } else if (r?.type === 'idle_timeout') {
        reject(new IdleTimeoutSignal(r.ms));
      } else if (r?.type === 'user') {
        reject(new UserInterrupt());
      } else if (r?.type === 'step_yield') {
        reject(new PriorityInboxInterrupt());
      } else {
        reject(makeExternalAbortError(r));
      }
    }, { once: true });
  });
  timeoutPromise.catch((e) => {
    opts.auditWriter.write(
      SUBAGENT_AUDIT_EVENTS.TIMEOUT_REJECTION,
      `agentId=${opts.agentId}`,
      `reason=${formatErr(e)}`,
    );
  });

  const cleanup = () => {
    clearTimeout(timeoutId);
    clearTimeout(idleTimerId);
    opts.externalSignal?.removeEventListener('abort', onExternalAbort);
    // 显式 abort 释放 timeoutPromise 的 signal-abort listener / mirror 原 agent.ts:405
    // 行为 / idempotent — 二次 abort 不再触发 listener.
    if (!controller.signal.aborted) controller.abort();
  };

  return { signal: controller.signal, timeoutPromise, resetIdle, cleanup };
}
