/**
 * phase 320: inbox message type constants consumed by Runtime intercept paths.
 *
 * Kept out of `runtime-audit-events.ts` so the audit-events snapshot lock
 * (which scans `audit-events.ts` files for `UPPER = 'lower'` literals) does
 * not pick up these non-audit constants.
 */

/**
 * Producer: CLI (`config provider set-primary|add|remove|move`).
 * Consumer: Runtime._drainOwnInbox 拦截路径 → llm.reloadConfig.
 */
export const RELOAD_LLM_CONFIG_MESSAGE_TYPE = 'reload_llm_config' as const;

/**
 * phase 1869 (Step G): EventLoop 生产的执行恢复提醒消息 type（消费者侧声明）。
 *
 * Runtime(L4) 不反向 import EventLoop(L5)（依赖方向 + type-only 环）；值必须与
 * `src/core/event-loop/constants.ts` 的 EXECUTION_RECOVERY_MESSAGE_TYPE 一致——
 * 跨模块一致性由 tests/core/runtime/execution-recovery-applicability.test.ts
 * 的相等断言锁定（drift 即红）。
 * Consumer: Runtime.prepareInbox 消费适用性判定（契约终态 → 不交付）。
 */
export const EXECUTION_RECOVERY_MESSAGE_TYPE = 'execution_recovery' as const;

/**
 * phase 1869 (Step G): 执行恢复交付义务的 inbox metadata 关联键（消费者侧声明，
 * 同上锁定）——Step G 审计行用它携带被跳过消息的 delivery_id。
 * 值必须与 `src/core/event-loop/constants.ts` 的
 * EXECUTION_RECOVERY_DELIVERY_META_KEY 一致（相等断言同上一处）。
 */
export const EXECUTION_RECOVERY_DELIVERY_META_KEY = 'execution_recovery_delivery_id' as const;
