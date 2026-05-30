/**
 * @module L6.Assembly.Guidance
 * phase 1469: Motion guidance registry impl.
 */

import type { GuidanceComposer, GuidanceEntry, MotionGuidanceRegistry } from './types.js';

/**
 * 装配期一次性创建 / 业主 register / Runtime motion-side compose append。
 *
 * mirror phase 1414 createMessageFormatterRegistry 模板（last-win 装配序、运行期不可变）。
 */
export function createMotionGuidanceRegistry(): MotionGuidanceRegistry {
  const map = new Map<string, GuidanceComposer<unknown>>();
  return {
    register<S>(type: string, composer: GuidanceComposer<S>): void {
      map.set(type, composer as GuidanceComposer<unknown>);
    },
    compose(type: string, state: Record<string, string>): GuidanceEntry | null {
      const composer = map.get(type);
      if (!composer) return null;
      // 不可预期失败暴露 / 不吞没 / Runtime 兜底 audit emit
      return composer(state as unknown);
    },
  };
}
