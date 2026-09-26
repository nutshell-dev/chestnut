/**
 * @module L6.Assembly.ClawCreation
 *
 * Phase 1911 Step H（RACE-CLAW-CREATE-PREMATERIALIZE）：claw 创建的稳定
 * claim/intent 与恢复 capability —— 由 claw 资源 owner（Assembly）持有。
 *
 * 协议（先取创建权、后物化、最后发布）：
 * 1. `claimClawCreation`：clawDir 内 `.create-claim` O_EXCL 独占写即创建权裁决。
 *    payload 记录 name + 模板/配置内容 hash + pid + createdAt。
 *    - 同 intent 的 EEXIST：同版本并发或 winner 崩溃恢复 —— resumed，幂等重放
 *      （物化幂等 no-replace、config O_EXCL 仲裁恰一 winner），无需活性探测；
 *    - 异 intent 或不可读/半写 claim：conflict，fail-closed 留证不动任何业务文件。
 * 2. `materializeClawCreation`：layout 子目录幂等 ensure（不覆盖文件）；模板先
 *    staging 完整落盘，再 hard-link 不可替换发布 —— 目标已有内容（winner 已发布 /
 *    用户编辑 / legacy 残留）一律保留既有字节。
 * 3. 发布提交点仍是 claw config 的 O_EXCL（saveClawConfigExclusive，1910 Step E
 *    不变）——读取方 ready 判据不变；audit 只在发布成功后发出。
 * 4. `completeClawCreation`：config 确认发布后 best-effort 清理 claim/staging。
 */
import { CLAW_SPEC_FILE } from '../foundation/claw-identity/index.js';
import { sha256Hex, formatErr } from '../foundation/node-utils/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { initializeClawLayout } from './claw-subdirs.js';

/** claw 创建 claim 文件名（clawDir 内 dot-file，业务读取方不可见）。 */
export const CLAW_CREATE_CLAIM_FILE = '.create-claim' as const;

/** 模板 staging 文件名（同 intent 内容字节相同，固定名幂等覆盖即可）。 */
const CLAW_CREATE_STAGING_FILE = '.create-staging' as const;

/**
 * 创建 intent 身份：name + 模板/配置内容 hash。判「同一创建意图」只看内容指纹，
 * 不信 pid/时间戳（时间戳是诊断不是活性证明）。
 */
export interface ClawCreationIntent {
  readonly name: string;
  readonly templateHash: string;
  readonly configHash: string;
}

export function makeClawCreationIntent(
  name: string,
  template: string,
  config: Record<string, unknown>,
): ClawCreationIntent {
  return {
    name,
    templateHash: sha256Hex(template),
    configHash: sha256Hex(JSON.stringify(config)),
  };
}

interface ClawCreationClaimPayload extends ClawCreationIntent {
  version: 1;
  pid: number;
  createdAt: string;
}

/** 序列化 claim payload（claimClawCreation 内部写与测试构造恢复现场共用同一真源）。 */
export function serializeClawCreationClaim(intent: ClawCreationIntent): string {
  const payload: ClawCreationClaimPayload = {
    version: 1,
    ...intent,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  return JSON.stringify(payload, null, 2);
}

export type ClawCreationClaimOutcome =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'resumed' }
  | { readonly kind: 'conflict'; readonly detail: string };

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

/**
 * 取得 claw 创建权。clawDir 不存在时由 writeExclusiveSync 父目录 invariant 创建
 * （空目录是合法残留，不含任何业务内容）。
 */
export function claimClawCreation(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawDir: string,
  intent: ClawCreationIntent,
): ClawCreationClaimOutcome {
  const fs = deps.fsFactory(clawDir);
  try {
    fs.writeExclusiveSync(CLAW_CREATE_CLAIM_FILE, serializeClawCreationClaim(intent));
    return { kind: 'acquired' };
  } catch (err) {
    if (!isEexist(err)) throw err;
  }
  // claim 已存在 —— 读完整 payload 裁决
  let existing: ClawCreationClaimPayload;
  try {
    existing = JSON.parse(fs.readSync(CLAW_CREATE_CLAIM_FILE)) as ClawCreationClaimPayload;
  } catch (err) {
    // 半写/不可读 claim 视为「创建进行中」证据，fail-closed 不动业务文件
    return { kind: 'conflict', detail: `unreadable claim: ${formatErr(err)}` };
  }
  if (
    existing.name === intent.name &&
    existing.templateHash === intent.templateHash &&
    existing.configHash === intent.configHash
  ) {
    return { kind: 'resumed' };
  }
  return {
    kind: 'conflict',
    detail: `different intent (claim templateHash=${String(existing.templateHash).slice(0, 12)}…)`,
  };
}

/**
 * 物化 layout + 模板。只对「尚无内容」的路径发布，绝不覆盖既有字节；
 * 可被同 intent 方并发/重入安全执行。
 */
export function materializeClawCreation(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawDir: string,
  template: string,
): void {
  const fs = deps.fsFactory(clawDir);
  // layout 子目录是幂等 ensure，不覆盖任何文件
  initializeClawLayout(fs);
  // 模板 staging 完整落盘（tmp+rename），再以 hard-link 不可替换发布
  fs.writeAtomicSync(CLAW_CREATE_STAGING_FILE, template);
  try {
    fs.linkExclusiveSync(CLAW_CREATE_STAGING_FILE, CLAW_SPEC_FILE);
  } catch (err) {
    if (!isEexist(err)) throw err;
    // silent: EEXIST = 目标已有内容（winner 已发布/用户编辑/legacy 残留）——保留既有字节不覆盖，本协议核心语义
  }
  try {
    fs.deleteSync(CLAW_CREATE_STAGING_FILE);
  } catch (err) {
    // silent: staging 清理 best-effort；残留由下次 materialize 的 writeAtomicSync 幂等覆盖
    void err;
  }
}

/**
 * config 发布确认后的 best-effort 清理。残留 claim 在 config 已发布后无副作用
 * （后续 create 由 config pre-check 拦截，不再读 claim）。
 */
export function completeClawCreation(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawDir: string,
): void {
  const fs = deps.fsFactory(clawDir);
  for (const p of [CLAW_CREATE_CLAIM_FILE, CLAW_CREATE_STAGING_FILE]) {
    try {
      fs.deleteSync(p);
    } catch (err) {
      // silent: FileNotFound = 已被并发同 intent 方清理；其他错误留证据不阻塞发布结果
      void err;
    }
  }
}
