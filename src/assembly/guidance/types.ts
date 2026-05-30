/**
 * @module L6.Assembly.Guidance
 * phase 1469: Motion guidance registry types.
 *
 * 应然（详 design/modules/l2_messaging.md §10）：
 * - motion 装配特化（per phase 1406 motion-config 第 4 件套）/ claw 装配不装
 * - 业主仅 own facts + structured state schema
 * - Assembly own guidance composer 物理（composers/<type>.ts、Assembly 自家写、不业主 export）
 * - composer 输出自由 text 单字段、含真实 CLI 字面（经 CLI_COMMANDS typed const 引用）+ 决策上下文
 * - sentinel NO_GUIDANCE 化解 ML#8 vs DP「不静默」+ ML#9 真冲突
 */

export interface GuidanceEntry {
  /** 自由 markdown / 自然语言、含 CLI 字面（经 CLI_COMMANDS 引用）+ 决策上下文 */
  text: string;
}

export type GuidanceComposer<S = Record<string, string>> = (state: S) => GuidanceEntry | null;

export interface MotionGuidanceRegistry {
  /**
   * 业主装配期显式 register 自家 type 的 composer（含 NO_GUIDANCE sentinel 表态 P3 类无 guidance）。
   * 装配期一次性调用、运行期不再改。
   */
  register<S = Record<string, string>>(type: string, composer: GuidanceComposer<S>): void;
  /**
   * Runtime motion-side append 时调、按 type lookup composer 并执行。
   * 未 register 返 null（Runtime fallback 仅 base body / 不 append guidance）。
   */
  compose(type: string, state: Record<string, string>): GuidanceEntry | null;
}

/**
 * Sentinel composer 表态此 type 无 guidance（P3 类 / 信息事件 / 无 actionable）。
 *
 * 业主装配期 `registry.register(type, NO_GUIDANCE)` 显式表态 / 漏注 invariant test 抓。
 *
 * 化解 ML#8（对外表面最小）vs DP「不静默」+ ML#9（显式表达）真冲突 — 单 register API
 * + sentinel typed value 满足两侧（详 §10.2 选项 3-C ratify）。
 */
export const NO_GUIDANCE: GuidanceComposer<unknown> = () => null;
