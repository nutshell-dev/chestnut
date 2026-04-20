/**
 * createRuntime — Runtime 装配工厂
 *
 * 依据 identity 分支构造 ClawRuntime 或 MotionRuntime，把 motion/claw 身份判定收敛到
 * 工厂入口；调用方（Assembly）不再直接 new。
 *
 * 输入：ClawRuntimeOptions + identity 字段（intersection type）
 * 输出：ClawRuntime | MotionRuntime（联合，共同方法在基类）
 * 边界：identity='motion' 时 clawId 由调用方传 MOTION_CLAW_ID（工厂不覆盖）
 * 失败：构造期同步抛出 ClawRuntime / MotionRuntime 构造器抛出的任何错
 *
 * 见 design/modules/l5_runtime.md §2.1
 */

import { ClawRuntime, type ClawRuntimeOptions } from './runtime.js';
import { MotionRuntime } from './motion/runtime.js';

export type CreateRuntimeOptions = ClawRuntimeOptions & {
  identity: 'motion' | 'claw';
};

export function createRuntime(
  options: CreateRuntimeOptions
): ClawRuntime | MotionRuntime {
  const { identity, ...runtimeOptions } = options;
  return identity === 'motion'
    ? new MotionRuntime(runtimeOptions)
    : new ClawRuntime(runtimeOptions);
}
