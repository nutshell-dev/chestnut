/**
 * @module L6.Assembly.Guidance.Bindings
 * phase 1266 Step A: `contract_events` Assembly typed binding（第四个 CLI guidance 纵向切片）。
 *
 * 职责边界（M#1/M#2）：
 * - 业主 (core/contract) own persisted refs、wire schema 与 codec
 *   （contract-events-guidance.ts：v1 refs JSON + 两套 legacy dialect + 安全 ID +
 *   mixed dialect / 整体失败语义）；
 * - CLIProtocol own action vocabulary、label/subject presentation 与最终渲染；
 * - 本 binding 是装配知识：只做 `contractRefs → 每 ref 先 trace 后 show 两行
 *   affordance + cap/空态选择`，不产 prose、CLI literal 或最终 entry（旧 composer
 *   自由文本职责移交 CLIProtocol）。
 *
 * 呈现策略保持（phase 1469/1487 既有 decision，本 phase 不改）：每 ref 严格
 * trace 后 show、cap=10 继续归 Assembly presentation 决策且 file-private；空
 * refs 显式 null（正文已完整覆盖 completed events、无失败契约需要 CLI 操作，
 * null 是显式「无 affordance」协议而非信息丢失）。owner state 无 discriminated
 * business union，故无 exhaustive switch（编译器已检查 typed interface 与
 * action shape）。
 *
 * decoder typed throw 原样穿透 register helper → Runtime GUIDANCE_COMPOSER_FAILED
 * audit 与正文保留链不变（本 phase 不改失败链）。完整 refs 继续在 persisted
 * metadata/body；truncation 只表达 total/shown presentation 事实，不截断或复制
 * owner state（shown 是展示的 owner 项数，不是生成的 CLI 行数）。
 *
 * import 仅限两侧稳定 protocol：CLIProtocol public barrel + ContractSystem owner
 * public barrel；不 import GuidanceComposer/GuidanceEntry/registry。
 */

import {
  defineCliGuidanceBinding,
  type CliGuidanceBinding,
  type CliGuidanceDocument,
  type CliGuidanceDocumentLine,
} from '../../../cli-protocol/index.js';
import {
  decodeContractEventsGuidance,
  type ContractEventsGuidanceState,
} from '../../../core/contract/index.js';

/**
 * Maximum claw-contract pair render count（guidance composer 内 contract events 展示上限）.
 * Derivation: 10 pair ≈ 一次 guidance refresh 可读取列表 / 平衡 prompt 完整 vs token 灌爆 /
 * 配合 audit footprint sample 同型经验值（FOOTPRINT_READS_TOP_N=20）/ 防 long event list 灌满 prompt.
 */
const MAX_PAIR_RENDER = 10;

export const contractEventsGuidanceBinding: CliGuidanceBinding<ContractEventsGuidanceState> = defineCliGuidanceBinding({
  type: 'contract_events',
  decode: decodeContractEventsGuidance,
  toDocument(state): CliGuidanceDocument | null {
    if (state.contractRefs.length === 0) return null;
    const refs = state.contractRefs.slice(0, MAX_PAIR_RENDER);
    return {
      truncation: state.contractRefs.length > MAX_PAIR_RENDER
        ? { total: state.contractRefs.length, shown: MAX_PAIR_RENDER, subject: 'contract-events' }
        : undefined,
      lines: refs.flatMap((ref): CliGuidanceDocumentLine[] => [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: ref.clawId, contractId: ref.contractId } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: ref.clawId, contractId: ref.contractId } },
      ]),
    };
  },
});
