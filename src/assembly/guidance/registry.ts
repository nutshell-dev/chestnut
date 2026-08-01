/**
 * @module L6.Assembly.Guidance
 * phase 1469: Motion guidance registry impl.
 */

import type { GuidanceEnvelope } from '../../core/runtime/index.js';
import type { GuidanceComposer, GuidanceEntry, MotionGuidanceRegistry } from './types.js';

/**
 * 装配期一次性创建 / 业主 register / Runtime motion-side compose append。
 *
 * mirror phase 1243 createInboxMessageTypeRegistry 模板（last-win 装配序、运行期不可变）。
 * phase 1256 Step B: compose 按 envelope.type lookup、envelope 原样转交 composer（不丢 from）。
 */
export function createMotionGuidanceRegistry(): MotionGuidanceRegistry {
  const map = new Map<string, GuidanceComposer<unknown>>();
  return {
    register<S>(type: string, composer: GuidanceComposer<S>): void {
      // 唯一不安全擦除封装在本实现内部（调用方与 composer 不新增 cast）
      map.set(type, composer as GuidanceComposer<unknown>);
    },
    compose(input: GuidanceEnvelope): GuidanceEntry | null {
      const composer = map.get(input.type);
      if (!composer) return null;
      // 不可预期失败暴露 / 不吞没 / Runtime 兜底 audit emit
      return composer(input);
    },
  };
}
