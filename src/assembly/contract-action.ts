/**
 * phase 1874 Step F (cli-contract-action-overassembly): contract CLI action 窄装配入口。
 *
 * 背景：CLI 为单次 contract create/cancel/show/events 自行构造
 * AuditLog + ToolRegistry (+ FileTools + ClawTopology wiring + Summon policy) + 完整
 * ContractSystem——模块装配在 CLI 复制、句柄无对称 dispose、ContractSystem 内部增长波及 CLI。
 *
 * 归属（F §4 判定）：动作**业务语义**（create 的 claim/verify、cancel 的终态转移）留
 * ContractSystem；「为一次动作组装运行栈」的**装配语义**归 Assembly（本文件；M#1 独立可变：
 * 装配随 owner 依赖面变化、动作语义随业务变化）。CLI 只消费本入口 + 呈现。
 *
 * dispose：本入口 own 其创建的 audit 生命周期；caller 在动作所有终态调 dispose()
 * （幂等、best-effort）。toolRegistry 为无状态注册表、无 dispose 需求。
 */
import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { createSystemAudit, type AuditLog } from '../foundation/audit/index.js';
import { createToolRegistry } from '../foundation/tools/index.js';
import { createFileTools } from '../foundation/file-tool/index.js';
import { getClawDir, makeClawId, resolveChestnutRoot } from '../foundation/claw-identity/index.js';
import { createClawNotifier } from '../foundation/messaging/index.js';
import { makeClawNotifyTargetResolver, MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { createContractSystem, type ContractSystem } from '../core/contract/index.js';
import { createSummonVerifyPolicy, createSummonCreationClaimStore } from '../core/summon-system/index.js';
import { loadSubAgentTask } from '../core/async-task-system/index.js';
import { wireClawTopology } from './wire-claw-topology.js';
import { createCrossTargetAccess } from './cross-target-access.js';

export interface ContractActionFsDeps {
  fsFactory: (baseDir: string) => FileSystem;
}

export interface ClawActionAudit {
  audit: AuditLog;
  /** 幂等 best-effort：flush/释放本入口创建的 audit 句柄。 */
  dispose: () => void;
}

/**
 * 轻量入口：仅为一次 owner 只读/审计动作提供 claw audit（如 contract events）。
 * 不构造 ContractSystem/ToolRegistry——按 action 最小依赖面（§7「按 action 拆分」）。
 */
export function createClawContractAudit(deps: ContractActionFsDeps, clawId: string): ClawActionAudit {
  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  const audit = createSystemAudit(clawFs, clawDir);
  return { audit, dispose: makeDispose(audit) };
}

export interface ContractActionContext extends ClawActionAudit {
  /** 与装配前 CLI 内联构造逐位等价的 ContractSystem（含 clawFs/clawDir 绑定）。 */
  system: ContractSystem;
}

/**
 * 完整入口：为一次 contract create/cancel/show 动作装配 ContractSystem。
 *
 * withSummonVerifyPolicy=true 时（create --dir 路径）额外装配 fileTools + ClawTopology wiring +
 * crossTargetAccess + summon-verify create policy（与迁移前 cli/index.ts 内联块逐位同序）。
 * false 时（create --file / cancel / show）保持原有裸 createToolRegistry() 形态（零行为漂移）。
 */
export async function createContractActionContext(
  deps: ContractActionFsDeps,
  clawId: string,
  opts: { withSummonVerifyPolicy?: boolean } = {},
): Promise<ContractActionContext> {
  const clawDir = getClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);
  const audit = createSystemAudit(clawFs, clawDir);
  const toolRegistry = createToolRegistry();

  let summonPolicy: ReturnType<typeof createSummonVerifyPolicy> | undefined;
  if (opts.withSummonVerifyPolicy) {
    // phase 1874 Step E: task 事实读取归 AsyncTaskSystem owner 窄查询
    const motionFs = deps.fsFactory(path.join(chestnutRoot, MOTION_CLAW_ID));
    summonPolicy = createSummonVerifyPolicy({
      auditWriter: audit,
      claimStore: createSummonCreationClaimStore({ fs: deps.fsFactory(chestnutRoot) }),
      loadTask: (taskId) => loadSubAgentTask(motionFs, taskId),
    });

    for (const tool of createFileTools()) {
      toolRegistry.register(tool);
    }
    wireClawTopology({
      fs: clawFs,
      chestnutRoot,
      audit,
      toolRegistry,
      isMotion: false,
      // phase 1864 Step G（CT-D10）：跨目标 capability 装配期授予。
      crossTargetAccess: createCrossTargetAccess({
        grantedBy: 'claw-cross-target',
        audit,
      }),
    });
  }

  // phase 1864 Step C（CT-D2）：发送归 Messaging；位置经拓扑 resolver 注入。
  const clawNotifier = createClawNotifier({
    fs: clawFs,
    audit,
    resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
  });
  const system = await createContractSystem({
    clawDir,
    clawId: makeClawId(clawId),
    fs: clawFs,
    audit,
    toolRegistry,
    fsFactory: deps.fsFactory,
    notifyClaw: (targetClawId, message) => clawNotifier.notify(targetClawId, message),
  });
  if (summonPolicy) {
    system.registerCreatePolicy('summon-verify', summonPolicy);
  }

  return { system, audit, dispose: makeDispose(audit) };
}

function makeDispose(audit: AuditLog): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      audit.dispose?.();
    } catch { /* silent: dispose best-effort——flush 失败不改变动作结果 */ }
  };
}
