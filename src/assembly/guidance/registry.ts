/**
 * @module L6.Assembly.Guidance
 * phase 1469: Motion guidance registry impl.
 */

import type { GuidanceEnvelope } from '../../core/runtime/index.js';
import type { GuidanceComposer, GuidanceEntry, MotionGuidanceRegistry } from './types.js';

/**
 * 装配期一次性创建 / 业主 register / Runtime motion-side compose append。
 *
 * mirror phase 1243 createInboxMessageTypeRegistry 模板（装配期注册、运行期不可变）。
 * phase 1256 Step B: compose 按 envelope.type lookup、envelope 原样转交 composer（不丢 from）。
 * phase 1877 Step E（cli-protocol-registrar-duplicate-gap 收口）：register 重复 type
 * fail-loud（同型先例：Messaging InboxMessageTypeRegistry 跨 owner 冲突 fail-loud）——
 * `Map.set` last-win 静默覆盖路径消除，typed/generic binding 不再因装配顺序漂移语义。
 */

/** 重复 type 注册冲突（含冲突 type；既有 composer 保持不变、无部分覆盖）。 */
export class GuidanceRegistryConflictError extends Error {
  constructor(type: string) {
    super(`guidance composer registration conflict: type=${JSON.stringify(type)} already registered`);
    this.name = 'GuidanceRegistryConflictError';
  }
}

export function createMotionGuidanceRegistry(): MotionGuidanceRegistry {
  const map = new Map<string, GuidanceComposer<unknown>>();
  return {
    register<S>(type: string, composer: GuidanceComposer<S>): void {
      if (map.has(type)) {
        throw new GuidanceRegistryConflictError(type);
      }
      // 唯一不安全擦除封装在本实现内部（调用方与 composer 不新增 cast）
      map.set(type, composer as GuidanceComposer<unknown>);
    },
    has(type: string): boolean {
      return map.has(type);
    },
    compose(input: GuidanceEnvelope): GuidanceEntry | null {
      const composer = map.get(input.type);
      if (!composer) return null;
      // 不可预期失败暴露 / 不吞没 / Runtime 兜底 audit emit
      return composer(input);
    },
  };
}
