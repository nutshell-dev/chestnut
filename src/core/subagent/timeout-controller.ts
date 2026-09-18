/**
 * phase 1489: 提取 SubAgent.run() 内嵌的「超时控制 + idle 计时 + 外部 signal 桥接」三合一编排。
 * derive M#1 — 超时策略与流回调 / 错误分类是独立可变方向。
 *
 * 行为契约（必与原 agent.ts 等价、tests/core/subagent.test.ts + task-subagent.test.ts 守）：
 * - timeoutMs 到点 → AbortController.abort({ type: 'turn_timeout', ms }) → timeoutPromise reject(ToolTimeoutError)
 * - idleTimeoutMs 到点 → onIdleTimeout?.() (throw → sink 留证、不阻断) → abort({ type: 'idle_timeout', ms })
 * - externalSignal abort → abort(externalSignal.reason)
 * - timeoutPromise 落地时 auditWriter emit SUBAGENT_AUDIT_EVENTS.TIMEOUT_REJECTION
 * - cleanup() 清两个 timer + remove external signal listener (idempotent)
 *
 * phase 1857 Step B (SE-D1): 中断统一经 step-executor 的 StepAbortError 数据协议载体
 * （idle_timeout/step_yield/user_interrupt），不再构造三独立信号 class。
 */

import { formatErr } from "../../foundation/node-utils/index.js";
import { ToolTimeoutError } from '../../foundation/tools/index.js';
import { StepAbortError } from '../step-executor/index.js';
import { makeExternalAbortError } from '../../foundation/llm-provider/index.js';
import type { SubAgentLifecycleSink } from './lifecycle-sink.js';

/**
 * phase 1802: SubAgent 超时 owner 自定义的 abort reason（发起业务 owner 持有词汇，
 * L1 provider 只作 opaque evidence 承载）。turn/idle 由本控制器发起；user/step_yield
 * 由 Runtime 发起、本边界负责映射到 StepAbortError 数据协议。
 */
type TurnTimerAbortReason =
  | { type: 'turn_timeout'; ms: number }
  | { type: 'idle_timeout'; ms: number };

/** 边界读取形态：外部 envelope 只作结构识别（type/ms），L1 不枚举上层 universe */
type AbortEnvelope = { type?: unknown; ms?: unknown };

interface TimeoutControllerOptions {
  timeoutMs: number;
  idleTimeoutMs?: number;
  onIdleTimeout?: () => void;
  externalSignal?: AbortSignal;
  /** phase 1858 Step K (SA-D10): audit 写点经 lifecycle sink（agentId 绑定在 adapter） */
  sink: SubAgentLifecycleSink;
}

interface TimeoutControllerHandle {
  signal: AbortSignal;
  timeoutPromise: Promise<never>;
  resetIdle?: () => void;
  cleanup: () => void;
}

export function createTimeoutController(opts: TimeoutControllerOptions): TimeoutControllerHandle {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort({ type: 'turn_timeout', ms: opts.timeoutMs } satisfies TurnTimerAbortReason);
  }, opts.timeoutMs);

  let idleTimerId: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = opts.idleTimeoutMs
    ? () => {
        clearTimeout(idleTimerId);
        idleTimerId = setTimeout(() => {
          try {
            opts.onIdleTimeout?.();
          } catch (err) {
            // phase 1858 Step L (SA-D11): callback 故障留证（原静默吞）；写失败由 sink adapter
            // 守卫走 stderr 最后手段。不 throw、abort 语义逐位保持。
            opts.sink.idleTimeoutCallbackFailed({ error: formatErr(err) });
          }
          controller.abort({ type: 'idle_timeout', ms: opts.idleTimeoutMs! } satisfies TurnTimerAbortReason);
        }, opts.idleTimeoutMs!);
      }
    : undefined;

  const onExternalAbort = () => {
    controller.abort(opts.externalSignal!.reason);
  };
  if (opts.externalSignal) {
    if (opts.externalSignal.aborted) onExternalAbort();
    else opts.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    const rejectForAbort = () => {
      const r = controller.signal.reason as AbortEnvelope | undefined;
      // 自产 turn/idle reason 恒带 number ms（TurnTimerAbortReason），typeof 守卫仅收窄
      if (r?.type === 'turn_timeout' && typeof r.ms === 'number') {
        reject(new ToolTimeoutError('subagent_run', r.ms));
      } else if (r?.type === 'idle_timeout' && typeof r.ms === 'number') {
        reject(new StepAbortError({ kind: 'idle_timeout', ms: r.ms }));
      } else if (r?.type === 'user') {
        reject(new StepAbortError({ kind: 'user_interrupt' }));
      } else if (r?.type === 'step_yield') {
        reject(new StepAbortError({ kind: 'step_yield' }));
      } else {
        reject(makeExternalAbortError(r));
      }
    };
    if (controller.signal.aborted) rejectForAbort();
    else controller.signal.addEventListener('abort', rejectForAbort, { once: true });
  });
  timeoutPromise.catch((e) => {
    const reason = controller.signal.reason as AbortEnvelope | undefined;
    if (reason?.type !== 'turn_timeout') return;
    opts.sink.timeoutRejection({ reason: formatErr(e) });
  });

  const cleanup = () => {
    clearTimeout(timeoutId);
    clearTimeout(idleTimerId);
    opts.externalSignal?.removeEventListener('abort', onExternalAbort);
    // 显式 abort 释放 timeoutPromise 的 signal-abort listener。正常 cleanup
    // 产生的外部 abort 不是 timeout，不得污染 TIMEOUT_REJECTION audit。
    if (!controller.signal.aborted) controller.abort();
  };

  return { signal: controller.signal, timeoutPromise, resetIdle, cleanup };
}
