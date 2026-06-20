/**
 * TraceId brand type (phase 140 立、phase 136 §5.B invariant 6 应然推导).
 *
 * SoT: runtime turn 起点 (phase 1343 α-6)
 * 形态: 16-byte hex（如 7b922f1afc4859e5）
 *
 * Invariants:
 * - 模块外不可造（__brand 编译期 check）
 * - 跨 turn 持续（per turn lifetime、turn_end 后失效）
 * - runtime 等价 string（audit emit cols 字面不变、M#7 + phase 393 跨进程契约）
 *
 * Note: canonical implementation lives in `foundation/audit/types.ts` to avoid
 * foundation→core layer violations. Runtime re-exports it here for SoT alignment.
 */
export type { TraceId } from '../../../foundation/audit/index.js';
export { makeTraceId } from '../../../foundation/audit/index.js';
