/**
 * @module L6.Assembly.Guidance.Bindings
 * phase 1267 Step A: `contract_cancelled` Assembly typed binding（第五个、最后一个 CLI guidance 纵向切片）。
 *
 * 职责边界（M#1/M#2）：
 * - 业主 (core/contract) own persisted refs、wire schema 与 codec
 *   （contract-cancelled-guidance.ts：v1 refs JSON + 两套 legacy dialect + 安全 ID +
 *   mixed dialect / 整体失败语义；legacy 取消事由只用于 owner 验证，事实留在持久化
 *   正文/audit，不跨边界交给 renderer）；
 * - CLIProtocol own action vocabulary、label/subject presentation 与最终渲染；
 * - 本 binding 是装配知识：只做 `contractRefs → 每 ref 先 trace 后 show 两行
 *   affordance + cap 选择`，不产 prose、CLI literal 或最终 entry（旧 composer
 *   自由文本职责移交 CLIProtocol）。
 *
 * 呈现策略保持（phase 63 γ/190/198 既有 decision，本 phase 不改）：每 ref 严格
 * trace 后 show、cap=10 继续归 Assembly presentation 决策且 file-private；与
 * contract_events 表面相反，owner schema 把 non-empty refs 定义为 invariant，
 * 空 refs 是 malformed 且必须在 decode 阶段 typed throw — 本 binding 不判空、不
 * fallback、不产 null 分支（Assembly 再判空会重复 owner 语义并可能把未来 decoder
 * 缺陷静默成 null）。owner state 无 discriminated business union，故无
 * exhaustive switch（编译器已检查 typed interface 与 action shape）。
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
  decodeContractCancelledGuidance,
  type ContractCancelledGuidanceState,
} from '../../../core/contract/index.js';

/**
 * Maximum cancelled contract batch render count（guidance 内 cancelled batch 展示上限）.
 * Derivation: 10 batch ≈ 一次 guidance 可读取的 cancelled entry 数 / 平衡 prompt 完整 vs token 灌爆 /
 * 与 contract-events binding 的 pair cap 同值同语义但 file-private（不抽 cross-file helper、playbook 否决）.
 */
const MAX_BATCH_RENDER = 10;

export const contractCancelledGuidanceBinding: CliGuidanceBinding<ContractCancelledGuidanceState> = defineCliGuidanceBinding({
  type: 'contract_cancelled',
  decode: decodeContractCancelledGuidance,
  toDocument(state): CliGuidanceDocument {
    const refs = state.contractRefs.slice(0, MAX_BATCH_RENDER);
    return {
      truncation: state.contractRefs.length > MAX_BATCH_RENDER
        ? { total: state.contractRefs.length, shown: MAX_BATCH_RENDER, subject: 'contract-cancellations' }
        : undefined,
      lines: refs.flatMap((ref): CliGuidanceDocumentLine[] => [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: ref.clawId, contractId: ref.contractId } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: ref.clawId, contractId: ref.contractId } },
      ]),
    };
  },
});
