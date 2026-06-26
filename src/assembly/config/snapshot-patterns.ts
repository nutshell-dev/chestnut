/**
 * Assembly 装配期聚合点：snapshot ignore patterns。
 *
 * phase 693：实现架构 §29 应然「gitignore patterns 通过参数注入（Assembly 装配期 own 与组装）」。
 * phase 157 revert：原把 patterns 归 foundation/snapshot/patterns.ts 的决策错位
 * （Snapshot L2a 不该 own 上层模块 ephemeral 资源字面 = M#5 预设上层语义违反）。
 *
 * 应然 anchor：
 * - M#3 资源唯一归属：各 owner module 自家声明 *_SNAPSHOT_IGNORE（stream / audit / async-task）
 * - M#5 模块依赖单向 + 底层不预设上层语义：Snapshot L2a 不知 list 内容
 * - DP「系统能自己做的就自己做好」：Assembly own composition 责任
 *
 * Sources（各 owner module 自家声明、本 file 仅 concat）：
 * - foundation/stream → STREAM_SNAPSHOT_IGNORE
 * - foundation/audit → AUDIT_SNAPSHOT_IGNORE
 * - core/async-task-system → TASK_SNAPSHOT_IGNORE
 */
import { STREAM_SNAPSHOT_IGNORE } from '../../foundation/stream/index.js';
import { AUDIT_SNAPSHOT_IGNORE } from '../../foundation/audit/index.js';
import { TASK_SNAPSHOT_IGNORE } from '../../core/async-task-system/index.js';

export const SNAPSHOT_IGNORE_PATTERNS: readonly string[] = [
  ...STREAM_SNAPSHOT_IGNORE,
  ...AUDIT_SNAPSHOT_IGNORE,
  ...TASK_SNAPSHOT_IGNORE,
];
