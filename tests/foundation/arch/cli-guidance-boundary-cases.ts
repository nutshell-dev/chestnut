/**
 * Phase 1266 Step A: cli-guidance-boundary 的纯 case interface + data（自
 * cli-guidance-boundary-helpers.ts 拆出；helpers 保留 scanner 原语）。
 *
 * 职责边界：本文件只承载 binding case 配置——随 typed binding 数量线性增长的
 * 纯数据，独立于 scanner 原语（helpers）与验收决策（.test.ts）；三处共同消费
 * 本单一数据源，不形成第二份 array 或循环 re-export。不含任何测试语义或生产
 * 语义。
 *
 * prose：该 binding 旧 composer 曾产的 presentation 前缀字面（迁后必消失）；
 * forbiddenFields：不参与 CLI affordance 的 owner state 字段（不得跨边界消费），
 * 使用带 `state.` 的精确 token（避免 owner import 路径/注释普通单词误报）。
 */

/**
 * 已迁 typed binding 的边界 case（逐 case 明确 owner codec / prose / forbidden
 * fields，禁止宽化成「任意 owner import」）。
 */
export interface CliGuidanceBindingBoundaryCase {
  readonly file: string;
  readonly type: string;
  readonly ident: string;
  readonly decoder: string;
  /** owner state 的 discriminated union 字段；无业务 union 的 case 省略（不伪造 switch）。 */
  readonly exhaustive?: string;
  readonly ownerCodec: string;
  readonly prose: string;
  readonly forbiddenFields: readonly string[];
}

export const CLI_GUIDANCE_BINDINGS: readonly CliGuidanceBindingBoundaryCase[] = [
  // phase 1383 (P2b): claw-inactivity binding 退场（停滞自活归 daemon 内化）。
  {
    file: 'claw-outbox-summary.ts',
    type: 'claw_outbox_summary',
    ident: 'clawOutboxSummaryGuidanceBinding',
    decoder: 'decodeOutboxSummaryGuidance',
    ownerCodec: '../../../core/claw-topology/index.js',
    prose: '查看具体内容',
    forbiddenFields: ['state.hash', 'state.counts', 'state.totalClaws'],
  },
  {
    file: 'contract-events.ts',
    type: 'contract_events',
    ident: 'contractEventsGuidanceBinding',
    decoder: 'decodeContractEventsGuidance',
    ownerCodec: '../../../core/contract/index.js',
    prose: 'contract events、显示前',
    forbiddenFields: [],
  },
  {
    file: 'contract-cancelled.ts',
    type: 'contract_cancelled',
    ident: 'contractCancelledGuidanceBinding',
    decoder: 'decodeContractCancelledGuidance',
    ownerCodec: '../../../core/contract/index.js',
    prose: 'cancellations、显示前',
    forbiddenFields: [],
  },
];
