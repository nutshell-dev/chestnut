/**
 * @module L6.Assembly.Guidance
 * phase 1469: Motion guidance registry types.
 *
 * 应然（详 design/modules/l2_messaging.md §10）：
 * - motion 装配特化（per phase 1406 motion-config 第 4 件套）/ claw 装配不装
 * - 业主仅 own facts + structured state schema
 * - Assembly own guidance composer 物理（composers/<type>.ts、Assembly 自家写、不业主 export）
 * - composer 输出自由 text 单字段 + 决策上下文；CLI affordance 不由 composer 拼字面，
 *   由 Assembly typed binding 产 CliGuidanceDocument、经 CLIProtocol 注册/渲染
 *   （phase 1263—1267；旧 renderClawInvocation / CONTRACT_COMMANDS 已退役为 CLIProtocol 内部实现）
 * - sentinel NO_GUIDANCE 化解 M#8 vs DP「不静默」+ M#9 真冲突
 */

import type { GuidanceEnvelope } from '../../core/runtime/index.js';

export interface GuidanceEntry {
  /** registry 通用最终 text 载体：自由 markdown / 自然语言 + 决策上下文；CLI affordance 经 Assembly typed binding 产 CliGuidanceDocument 由 CLIProtocol 渲染，不在此拼 CLI 字面 */
  text: string;
}

/**
 * phase 1256 Step B: composer 原样消费 Runtime envelope（type/from/meta 三字段全保真）。
 * 现有 real composer 只从 `input.meta` 读取旧 state；唯一不安全擦除封装在 registry register 实现内部。
 */
export type GuidanceComposer<S = Readonly<Record<string, string>>> = (
  input: GuidanceEnvelope & { readonly meta: S },
) => GuidanceEntry | null;

export interface MotionGuidanceRegistry {
  /**
   * 业主装配期显式 register 自家 type 的 composer（含 NO_GUIDANCE sentinel 表态 P3 类无 guidance）。
   * 装配期一次性调用、运行期不再改。
   * phase 1877 Step E（cli-protocol-registrar-duplicate-gap 收口）：重复 type fail-loud
   * （throw、含冲突 type），不再 `Map.set` last-win 静默覆盖；既有 composer 保持不变。
   */
  register<S = Readonly<Record<string, string>>>(type: string, composer: GuidanceComposer<S>): void;
  /**
   * 查询 type 是否已注册（phase 1877 Step E：CLIProtocol `CliGuidanceRegistrar` 跨批
   * 重复门禁的结构适配面；typed binding 与 generic composer 同一命名空间）。
   */
  has(type: string): boolean;
  /**
   * Runtime motion-side append 时调、按 envelope.type lookup composer 并原样传 envelope。
   * 未 register 返 null（Runtime fallback 仅 base body / 不 append guidance）。
   * phase 1256 Step B: compose 直消费 envelope（不丢 from / 不重建对象）。
   */
  compose(input: GuidanceEnvelope): GuidanceEntry | null;
}

/**
 * Sentinel composer 表态此 type 无 guidance（P3 类 / 信息事件 / 无 actionable）。
 *
 * 业主装配期 `registry.register(type, NO_GUIDANCE)` 显式表态 / 漏注 invariant test 抓。
 *
 * 化解 M#8（对外表面最小）vs DP「不静默」+ M#9（显式表达）真冲突 — 单 register API
 * + sentinel typed value 满足两侧（详 §10.2 选项 3-C ratify）。
 */
export const NO_GUIDANCE: GuidanceComposer<unknown> = () => null;
