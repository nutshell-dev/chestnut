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
 *
 * phase 1866 Step C（SU-D2）SoT 声明（创建 evidence 单一）：
 * - 本 store 是**唯一**创建事实 authority（写点只有 policy 的 claimCreation；读点 =
 *   post-processor 恢复核实 + 单一恢复入口的 claim 核对）；
 * - 回执（task result envelope）= 结果交付面，不是 evidence；
 * - legacy `summonDecision`（v1/v2）= 存量废弃字段（phase 1890 Step E 读面已删，
 *   policy 对仍带 decision 的任务 fail-closed），不是第二 writer/authority；
 * - pending-retrospective = 观测/补报面，不是创建 evidence。
 *
 * Phase 1948 Step B：claim 发布改 staging + hard link 原子提交（与 Phase 1947 ATS
 * prepared claim 同根因模式）——writeExclusive 直发会让 claim 路径在内容写完前可见，
 * 并发 loser 观察到空/半写文件；现 claim 路径首次可见即完整。崩溃残留 staging 由
 * sweepStaging（daemon 启动装配点调用）按孤儿年龄收敛。
 */

import { z } from 'zod';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr, newUuid } from '../../foundation/node-utils/index.js';

/** claim 根目录（相对 chestnutRoot）。 */
export const SUMMON_CREATION_CLAIMS_DIR = 'summons' as const;
export const SUMMON_CREATION_CLAIM_FILE = 'creation-claim.json' as const;
/**
 * Phase 1948 Step B：staging 文件名前缀（唯一 UUID token 拼接在后）。
 * staging 与 claim 同目录（`summons/<summonId>/`，同文件系统，hard link 前提满足）；
 * 不承载身份语义——claim 路径是唯一权威入口。
 */
export const SUMMON_CREATION_CLAIM_STAGING_PREFIX = '.creation-claim-staging-' as const;
/**
 * Phase 1948 Step B：崩溃残留 staging 的孤儿年龄阈值。
 * sweep 只删 mtime 早于此年龄的 staging——进行中的 claim（CLI 与 daemon 可并发持有
 * 本 store，无 ATS 那样的单 daemon 前提）其新鲜 staging 绝不被误删。
 */
export const SUMMON_CLAIM_STAGING_ORPHAN_AGE_MS = 60 * 60_000;

const SummonCreationClaimSchema = z.object({
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
  /**
   * phase 1866 Step H（SU-D8）：列全部 claim（authority 面恢复核对）。
   * 逐项读取失败不静默：进 `unreadable`（summonId + detail），其余照常返回。
   */
  list(): Promise<SummonCreationClaimListing>;
  /**
   * Phase 1948 Step B：清理崩溃残留的 claim staging 文件。
   * 只删 `SUMMON_CREATION_CLAIM_STAGING_PREFIX` 前缀且 mtime 早于
   * `SUMMON_CLAIM_STAGING_ORPHAN_AGE_MS` 的 staging；绝不动 `creation-claim.json`。
   * 单项失败不 throw：进 `failures`（summonId + detail），由装配点 audit 留证。
   */
  sweepStaging(): Promise<SummonCreationClaimSweepResult>;
}

/** claim 列举结果（owner 侧扫描；损坏/不可读项显式列出）。 */
export interface SummonCreationClaimListing {
  readonly readable: boolean;
  readonly claims: readonly SummonCreationClaim[];
  readonly unreadable: readonly { readonly summonId: string; readonly detail: string }[];
}

/** Phase 1948 Step B：staging sweep 结果（不 throw，失败项显式列出）。 */
export interface SummonCreationClaimSweepResult {
  readonly cleaned: number;
  readonly failures: readonly { readonly summonId: string; readonly detail: string }[];
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
 * Phase 1908 Step E: 读面 identity 绑定 —— 路径 key（summonId 目录名）与内容
 * `claim.summonId` 必须一致；错配即 corrupted（fail-closed 保留证据），绝不把
 * 目录 A 中内容 summonId B 的 claim 交付给恢复核实。
 */
function parseClaimForIdentity(raw: string, path: string, expectedSummonId: string): SummonCreationClaim {
  const claim = parseClaim(raw, path);
  if (claim.summonId !== expectedSummonId) {
    throw new SummonCreationClaimCorruptedError(
      path,
      new Error(`claim summonId '${claim.summonId}' does not match path key '${expectedSummonId}'`),
    );
  }
  return claim;
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
      // Phase 1948 Step B：staging + link 原子发布（与 Phase 1947 ATS prepared claim
      // 同根因模式）。完整内容 + fsync 先落在唯一 staging 路径（此时 claim 路径不可见），
      // 再以 linkExclusiveSync 原子 no-replace 提交——claim 路径首次可见即内容完整，
      // loser 要么看到完整 claim、要么看不到路径（不再有空/半写窗口）。
      const stagingPath =
        `${SUMMON_CREATION_CLAIMS_DIR}/${input.summonId}/${SUMMON_CREATION_CLAIM_STAGING_PREFIX}${newUuid()}`;
      try {
        // staging 的 writeExclusive EEXIST（UUID 碰撞）按异常上抛；概率可忽略。
        await fs.writeExclusive(stagingPath, serializeClaim(claim));
        try {
          // 原子 no-replace 提交：link 成功后 staging 与 claim 同 inode，
          // finally 删除 staging 不影响 claim。
          fs.linkExclusiveSync(stagingPath, path);
          return { kind: 'claimed', claim };
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
          // EEXIST：winner 已提交完整 claim；落到下方读取
        }
      } finally {
        try {
          await fs.delete(stagingPath);
        } catch {
          // silent: store 无 audit writer；清理失败的残留 staging 由启动 sweepStaging 收敛
          //（staging 不承载语义，claim 提交语义在 link 成功时已完成）。
        }
      }
      // EEXIST：严格读取比较。同候选 = 重试幂等通过；不同候选 = 拒绝；损坏 = typed error。
      let existing: SummonCreationClaim | undefined;
      // legacy 防御保留（Phase 1948 前由 writeExclusive 直发产生的半写窗口已消除；
      // 重读循环仅作 belt-and-suspenders，正常路径一次读取即得完整 claim）。
      for (let attempt = 0; attempt < 100 && existing === undefined; attempt++) {
        try {
          existing = parseClaim(await fs.read(path), path);
        } catch (err) {
          if (isFileNotFound(err)) {
            throw new SummonCreationClaimCorruptedError(path, err);
          }
          if (err instanceof SummonCreationClaimCorruptedError && attempt < 99) {
            await new Promise<void>(resolve => setImmediate(resolve));
            continue;
          }
          throw err;
        }
      }
      if (existing === undefined) {
        throw new SummonCreationClaimCorruptedError(path);
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
      return parseClaimForIdentity(raw, path, summonId);
    },

    async list() {
      let entries: { name: string; isDirectory: boolean }[];
      try {
        entries = fs.listSync(SUMMON_CREATION_CLAIMS_DIR, { includeDirs: true });
      } catch (err) {
        if (isFileNotFound(err)) return { readable: true, claims: [], unreadable: [] };
        // silent: 目录级不可读以 readable=false 交付（DP：恢复入口把它记进 issues，不吞没）
        return { readable: false, claims: [], unreadable: [] };
      }
      const claims: SummonCreationClaim[] = [];
      const unreadable: { summonId: string; detail: string }[] = [];
      for (const entry of entries.filter(e => e.isDirectory)) {
        const summonId = entry.name;
        const path = claimPath(summonId);
        try {
          claims.push(parseClaimForIdentity(await fs.read(path), path, summonId));
        } catch (err) {
          if (isFileNotFound(err)) continue; // 目录存在但 claim 未落盘 = 无创建事实记录，非异常项
          unreadable.push({ summonId, detail: formatErr(err) });
        }
      }
      return { readable: true, claims, unreadable };
    },

    async sweepStaging() {
      const result: { cleaned: number; failures: { summonId: string; detail: string }[] } = {
        cleaned: 0,
        failures: [],
      };
      let summonDirs;
      try {
        summonDirs = await fs.list(SUMMON_CREATION_CLAIMS_DIR, { includeDirs: true });
      } catch (err) {
        if (isFileNotFound(err)) return result; // claims 根目录不存在 = 无残留，非异常
        result.failures.push({ summonId: '(root)', detail: `list:${formatErr(err)}` });
        return result;
      }
      const now = Date.now();
      for (const dir of summonDirs.filter(e => e.isDirectory)) {
        const summonId = dir.name;
        let entries;
        try {
          entries = await fs.list(`${SUMMON_CREATION_CLAIMS_DIR}/${summonId}`, { includeDirs: false });
        } catch (err) {
          if (isFileNotFound(err)) continue; // 目录在 sweep 期间消失 = 无残留可清
          result.failures.push({ summonId, detail: `list:${formatErr(err)}` });
          continue;
        }
        for (const entry of entries) {
          if (!entry.isFile || !entry.name.startsWith(SUMMON_CREATION_CLAIM_STAGING_PREFIX)) continue;
          if (now - entry.mtime.getTime() < SUMMON_CLAIM_STAGING_ORPHAN_AGE_MS) continue; // 新鲜 staging = 进行中 claim，绝不误删
          try {
            await fs.delete(`${SUMMON_CREATION_CLAIMS_DIR}/${summonId}/${entry.name}`);
            result.cleaned++;
          } catch (err) {
            if (isFileNotFound(err)) continue; // 已被并发清理
            result.failures.push({ summonId, detail: `delete ${entry.name}:${formatErr(err)}` });
          }
        }
      }
      return result;
    },
  };
}
