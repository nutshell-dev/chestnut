/**
 * @module L6.Assembly.ContractBridgeDispose
 * @layer L6 装配层
 *
 * phase 1808 Step B（MEMORY-CONTRACT-BRIDGE-DISPOSE-FAILURE-SILENT）：
 * Memory↔Contract bridge 缓存 ContractSystem 的 close 结果 typed outcome owner。
 *
 * phase 1807 后 per-claw ContractSystem 构造/缓存/close 收口装配层
 * （motion-addons），bridge 只缓存窄 reader capability。本模块承接 close 集合
 * 语义：`Promise.allSettled` 只负责并发收集，rejected 按 entries identity
 * （clawId）归因并保留原始 error 投影——不以静默 allSettled 伪造成功，
 * 清空/重试策略不混入本模块（close 幂等性由 ContractSystem._closed guard 保证）。
 */

import { formatErr } from '../foundation/node-utils/index.js';

/** 单个缓存 ContractSystem 的 close 失败证据。 */
export interface ContractBridgeDisposeFailure {
  /** 被关闭 ContractSystem 归属的 claw identity（缓存 key） */
  clawId: string;
  /** 原始 close rejection 的 formatErr 投影 */
  error: string;
}

export type ContractBridgeDisposeResult =
  | { kind: 'complete' }
  | { kind: 'partial_failure'; failures: readonly ContractBridgeDisposeFailure[] };

/** 可关闭资源的最小 capability（ContractSystem 结构子集）。 */
export interface ContractBridgeCloseable {
  // phase 1860 (RT-D5)：ContractSystem.close 返回 typed ContractCloseOutcome；
  // 本桥接只关心 settle 状态、用 unknown 保持最小面（不引入 contract 类型依赖）。
  close(): Promise<unknown>;
}

/**
 * 并发 close 全部缓存条目并返回 typed outcome：
 * 全部 fulfilled → complete；任一 rejected → partial_failure 携逐条证据。
 * 失败归因按 entries 下标（cache identity），不依赖 Promise settle 顺序。
 */
export async function closeBridgeContractSystems(
  entries: readonly { clawId: string; cs: ContractBridgeCloseable }[],
): Promise<ContractBridgeDisposeResult> {
  // phase 517 B8: allSettled 兜底、单个 close 失败不阻其他
  const settled = await Promise.allSettled(entries.map(e => e.cs.close()));
  const failures: ContractBridgeDisposeFailure[] = settled.flatMap((r, i) =>
    r.status === 'rejected'
      ? [{ clawId: entries[i].clawId, error: formatErr(r.reason) }]
      : [],
  );
  return failures.length > 0
    ? { kind: 'partial_failure', failures }
    : { kind: 'complete' };
}
