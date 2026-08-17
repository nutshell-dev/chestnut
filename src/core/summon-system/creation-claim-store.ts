/**
 * @module L4.SummonSystem.CreationClaimStore
 *
 * Phase 1396 Step B: SummonSystem 独占的 summon-scoped contract 创建 claim。
 *
 * 0/1 不变量（design: Phase 1396 总览 §4）：
 *   succeeded <=> 恰好一个 contract
 *   failed    <=> 零个 contract
 *
 * 同一 summon task 的首个合法候选取得 durable claim；同候选重试幂等通过（same_claim），
 * 不同候选被拒（SummonContractAlreadyClaimedError）。claim 是 summon 创建事实的
 * 恢复锚点：回执丢失后由 post-processor 读 claim 并经 ContractSystem 核实创建事实。
 *
 * M#3 资源唯一归属：`.chestnut/summons/<summonId>/creation-claim.json` 由 SummonSystem
 * 独占；ContractSystem 不理解 summon，也不保存 caller correlation。
 */

import { z } from 'zod';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';

/** claim 根目录（相对 chestnutRoot）。 */
export const SUMMON_CREATION_CLAIMS_DIR = 'summons' as const;
export const SUMMON_CREATION_CLAIM_FILE = 'creation-claim.json' as const;

export const SummonCreationClaimSchema = z.object({
  schema_version: z.literal(1),
  summonId: z.string().min(1),
  targetExecutorId: z.string().min(1),
  contractId: z.string().min(1),
  claimedAt: z.string().min(1),
});

export type SummonCreationClaim = z.infer<typeof SummonCreationClaimSchema>;

export type SummonCreationClaimInput = Omit<SummonCreationClaim, 'schema_version' | 'claimedAt'>;

export type SummonCreationClaimResult =
  | { kind: 'claimed'; claim: SummonCreationClaim }
  | { kind: 'same_claim'; claim: SummonCreationClaim };

/**
 * 同一 summonId 已 claim 不同候选（targetExecutorId 或 contractId 不同）。
 * 0/1 不变量的拒绝信号；policy 层包装为 ContractCreatePolicyViolationError 交付。
 */
export class SummonContractAlreadyClaimedError extends Error {
  constructor(
    public readonly existing: SummonCreationClaim,
    public readonly requested: SummonCreationClaimInput,
  ) {
    super(
      `summon '${existing.summonId}' already claimed contract '${existing.contractId}' ` +
      `on executor '${existing.targetExecutorId}'; ` +
      `refusing different candidate '${requested.contractId}' on '${requested.targetExecutorId}'`,
    );
    this.name = 'SummonContractAlreadyClaimedError';
  }
}

/** 已持久化的 claim 无法解析 —— 恢复核实需要真相，禁止静默覆盖。 */
export class SummonCreationClaimCorruptedError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause?: unknown,
  ) {
    super(`summon creation claim corrupted: ${path}`);
    this.name = 'SummonCreationClaimCorruptedError';
  }
}

export interface SummonCreationClaimStore {
  claim(input: SummonCreationClaimInput): Promise<SummonCreationClaimResult>;
  read(summonId: string): Promise<SummonCreationClaim | undefined>;
}

function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

/** summonId 直接拼入路径；防御 path traversal（TaskId 实然为 UUID，此处 fail-closed）。 */
function assertSafeSummonId(summonId: string): void {
  if (
    typeof summonId !== 'string' ||
    summonId === '' ||
    summonId.startsWith('.') ||
    summonId.includes('/') ||
    summonId.includes('\\') ||
    /[\x00-\x1f]/.test(summonId) ||
    summonId.includes('..')
  ) {
    throw new Error(`Invalid summon id for creation claim: ${JSON.stringify(summonId)}`);
  }
}

function serializeClaim(claim: SummonCreationClaim): string {
  return JSON.stringify(claim, null, 2);
}

function parseClaim(raw: string, path: string): SummonCreationClaim {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SummonCreationClaimCorruptedError(path, err);
  }
  const result = SummonCreationClaimSchema.safeParse(parsed);
  if (!result.success) throw new SummonCreationClaimCorruptedError(path, result.error);
  return result.data;
}

/**
 * 创建 summon 创建 claim store。
 *
 * @param deps.fs  rooted at chestnutRoot（`.chestnut`）；store 写 `summons/<summonId>/creation-claim.json`。
 *                 CLI 与 daemon 通过同一 factory 注入，不直接拼路径。
 */
export function createSummonCreationClaimStore(deps: { fs: FileSystem }): SummonCreationClaimStore {
  const { fs } = deps;
  const claimPath = (summonId: string): string =>
    `${SUMMON_CREATION_CLAIMS_DIR}/${summonId}/${SUMMON_CREATION_CLAIM_FILE}`;

  return {
    async claim(input) {
      assertSafeSummonId(input.summonId);
      const path = claimPath(input.summonId);
      const claim: SummonCreationClaim = {
        schema_version: 1,
        ...input,
        claimedAt: new Date().toISOString(),
      };
      try {
        await fs.writeExclusive(path, serializeClaim(claim));
        return { kind: 'claimed', claim };
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
      // EEXIST：严格读取比较。同候选 = 重试幂等通过；不同候选 = 拒绝；损坏 = typed error。
      let existing: SummonCreationClaim;
      try {
        existing = parseClaim(await fs.read(path), path);
      } catch (err) {
        if (isFileNotFound(err)) {
          // 读时文件消失（外部干预）：不当成功也不当冲突，按损坏处理、保留证据。
          throw new SummonCreationClaimCorruptedError(path, err);
        }
        throw err;
      }
      if (
        existing.summonId === input.summonId &&
        existing.targetExecutorId === input.targetExecutorId &&
        existing.contractId === input.contractId
      ) {
        return { kind: 'same_claim', claim: existing };
      }
      throw new SummonContractAlreadyClaimedError(existing, input);
    },

    async read(summonId) {
      assertSafeSummonId(summonId);
      const path = claimPath(summonId);
      let raw: string;
      try {
        raw = await fs.read(path);
      } catch (err) {
        if (isFileNotFound(err)) return undefined;
        throw err;
      }
      return parseClaim(raw, path);
    },
  };
}
