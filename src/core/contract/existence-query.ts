/**
 * Contract 存在性只读查询（phase 1872 Step E，assembly-cross-claw-contract-query-overbuild 收口）。
 *
 * callers（Summon 跨 executor verify）需要「某 claw 目录下 contract 是否已提交」——
 * 此前 Assembly 为**每次查询**构造 fs + audit + notifier + 完整 ContractSystem，只调
 * hasContract 一次、且无对称 dispose。本查询 0-instance-dep：直接复用 owner 的
 * resolveContractLocation（active 发布态 + archive 当前态/legacy 判定、歧义重试一次
 * 后 fail-closed 抛错）——不构造任何业务实例（形态对齐 1846 terminal-fact.ts）。
 *
 * 语义与 `ContractSystem.hasContract` 等价（同一底层 helper）：
 * - active 根存在且已发布（无 `.creating` marker）→ 命中；
 * - archive/<state>/<id>（当前态）或 legacy flat archive/<id> 存在 → 命中；
 * - 任一命中 → true；全无 → false；
 * - 多位置歧义 → 重试一次后抛 ContractLocationAmbiguityError（不折 false）。
 * 登记差异：0-instance-dep 查询无 exec 侧 audit 通道——歧义审计行（CONTRACT_MULTI_DIR）
 * 不再由本查询发出（异常本身照常抛出、fail-closed 不变）。
 *
 * 只读：无写副作用、无缓存；claw 目录布局演进只影响本 owner 实现。
 */
import type { FileSystem } from '../../foundation/fs/index.js';
import { resolveContractLocation } from './locations.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_ARCHIVE_DIR } from './dirs.js';
import { makeArchiveDir, type ContractId } from './types.js';

/** 判定 contract 是否存在（active 发布态 ∪ archive）于 fs 所属 claw 目录。 */
export async function queryContractExistence(
  fs: FileSystem,
  contractId: ContractId,
): Promise<boolean> {
  const location = await resolveContractLocation({
    fs,
    activeDir: CONTRACT_ACTIVE_DIR,
    archiveDir: makeArchiveDir(CONTRACT_ARCHIVE_DIR),
    contractId,
  });
  return location !== null;
}
