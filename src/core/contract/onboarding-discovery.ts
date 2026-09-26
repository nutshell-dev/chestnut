/**
 * @module L4.ContractSystem.OnboardingDiscovery
 * 0-dep pure helper for CLI static phase (pre-init / no ContractSystem instance).
 * Sibling of discovery.ts ctx-injected loadActiveContract.
 */
import * as path from 'node:path';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  CONTRACT_ACTIVE_DIR,
  PROGRESS_FILE,
  CONTRACT_YAML_FILE,
} from './dirs.js';
import { listArchiveContractLocations, archiveContainerDir } from './locations.js';
import { CREATION_CLAIM_FILE } from './creation.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { makeContractId, type ContractId } from './types.js';

/**
 * Phase 1910 Step C: onboarding 业务唯一身份（RACE-START-ONBOARDING-SINGLETON）。
 *
 * onboarding contract 的稳定显式 id——创建权由 ContractSystem 既有 `.creating`
 * O_EXCL claim 在该稳定 id 上裁决；并发 `start` 的 loser 得到 already_exists 后
 * 重读 winner 事实转 resume，不再各自生成随机 id。普通合同保留随机 id 语义。
 */
export const ONBOARDING_CONTRACT_ID: ContractId = makeContractId('onboarding');

type OnboardingStatusKind = 'not_found' | 'in_progress' | 'complete';

export interface OnboardingStatus {
  state: OnboardingStatusKind;
  contractId?: string;
  pending?: string[];
}

interface ProgressSubtask { status?: string; }
interface ProgressShape { subtasks?: Record<string, ProgressSubtask>; }

/**
 * 取一个 onboarding contract atomic snapshot：(state, contractId?, pending?)
 * - 0 ContractSystem instance dep
 * - fs 可注入便于 mock TOCTOU race simulate
 * - retains 6-site silent-swallow semantics (catch-blocks with continue)
 * - audit optional：CLI 静态阶段无 audit infra 时跳过、有则 emit forensics
 */
export function readOnboardingStatus(
  motionDir: string,
  deps: { fsFactory: (baseDir: string) => FileSystem; audit?: AuditLog },
): OnboardingStatus {
  const fs = deps.fsFactory(motionDir);
  // phase 1127 Step C: scan active dir first, then current archive state dirs + legacy flat.
  const archiveEntries = listArchiveContractLocations({ fs, archiveDir: archiveContainerDir() });
  if (fs.existsSync(CONTRACT_ACTIVE_DIR)) {
    let entries: string[] = [];
    try { entries = fs.listSync(CONTRACT_ACTIVE_DIR, { includeDirs: true }).map(e => e.name); } catch { /* silent: TOCTOU race or ENOENT during dir scan */ }
    for (const contractId of entries) {
      const contractYaml = path.join(CONTRACT_ACTIVE_DIR, contractId, CONTRACT_YAML_FILE);
      const progressJson = path.join(CONTRACT_ACTIVE_DIR, contractId, PROGRESS_FILE);
      if (!fs.existsSync(contractYaml) || !fs.existsSync(progressJson)) continue;
      let title = '';
      try {
        const yaml = fs.readSync(contractYaml);
        const m = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        title = m?.[1] ?? '';
      } catch { /* silent: contract.yaml read race — skip to next contract */ continue; }
      if (title !== 'Onboarding') continue;
      let progress: ProgressShape;
      try {
        progress = JSON.parse(fs.readSync(progressJson)) as ProgressShape;
      } catch (err) {
        deps.audit?.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_ONBOARDING_PROGRESS_PARSE_FAILED,
          `path=${progressJson}`,
          `error=${formatErr(err)}`,
        );
        continue;
      }
      const subtasks = progress.subtasks ?? {};
      const pending = Object.entries(subtasks)
        .filter(([, v]) => v.status !== 'completed')
        .map(([k]) => k);
      return { state: 'in_progress', contractId, pending };
    }
  }

  for (const entry of archiveEntries) {
    const contractYaml = path.join(entry.contractRoot, CONTRACT_YAML_FILE);
    const progressJson = path.join(entry.contractRoot, PROGRESS_FILE);
    if (!fs.existsSync(contractYaml) || !fs.existsSync(progressJson)) continue;
    let title = '';
    try {
      const yaml = fs.readSync(contractYaml);
      const m = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      title = m?.[1] ?? '';
    } catch { /* silent: contract.yaml read race — skip to next contract */ continue; }
    if (title !== 'Onboarding') continue;
    let progress: ProgressShape;
    try {
      progress = JSON.parse(fs.readSync(progressJson)) as ProgressShape;
    } catch (err) {
      deps.audit?.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_ONBOARDING_PROGRESS_PARSE_FAILED,
        `path=${progressJson}`,
        `error=${formatErr(err)}`,
      );
      continue;
    }
    const subtasks = progress.subtasks ?? {};
    const pending = Object.entries(subtasks)
      .filter(([, v]) => v.status !== 'completed')
      .map(([k]) => k);
    if (pending.length === 0) {
      return { state: 'complete' };
    }
    return { state: 'in_progress', contractId: entry.contractId, pending };
  }

  return { state: 'not_found' };
}

// ============================================================================
// Phase 1911 Step I（RACE-ONBOARDING-LEGACY-ID-MIGRATION）：onboarding 业务身份
// 唯一性裁决。title 扫描快照（readOnboardingStatus 首个命中即返回）不能授权
// stable create——旧随机 active/archive、多候选、损坏证据、未发布 `.creating`
// claim 都可能被快照掩盖而与 stable contract 静默并存。
//
// 本 owner capability 在创建前枚举全部候选并分类：
// - 零候选 → absent（准 stable create）；
// - 恰好一个 → unique（复用既有业务身份转 resume，旧随机 id 只做读取映射、
//   保留物理路径，不改名/不迁移）；
// - 多候选 / 损坏 / 未发布异 id onboarding claim → conflict，fail-closed 留证，
//   绝不覆盖。
// stable id 自己的 `.creating` claim 不计候选——创建权仍由 ContractSystem
// `.creating` O_EXCL + recoverCreation 裁决（1910 Step C 不变）。
// ============================================================================

export type OnboardingIdentityVerdict =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'unique';
      readonly contractId: string;
      readonly state: 'in_progress' | 'complete';
      readonly pending: string[];
    }
  | { readonly kind: 'conflict'; readonly candidates: string[]; readonly detail: string };

interface OnboardingCandidate {
  readonly contractId: string;
  readonly location: 'active' | 'archive' | 'creating';
  readonly state: 'in_progress' | 'complete' | 'unpublished' | 'damaged';
  readonly pending: string[];
}

/** 读 contract.yaml title；不可读返回 undefined（无法识别身份，不当候选）。 */
function readContractTitle(fs: FileSystem, contractYamlPath: string): string | undefined {
  try {
    const yaml = fs.readSync(contractYamlPath);
    const m = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    return m?.[1] ?? '';
  } catch {
    // silent: contract.yaml 读竞赛/损坏 → 无法判定归属，不识别为 onboarding 候选
    return undefined;
  }
}

/** 读 progress.json pending 列表；不可读/损坏返回 undefined（= damaged 证据）。 */
function readPendingSubtasks(fs: FileSystem, progressPath: string): string[] | undefined {
  try {
    const progress = JSON.parse(fs.readSync(progressPath)) as ProgressShape;
    const subtasks = progress.subtasks ?? {};
    return Object.entries(subtasks)
      .filter(([, v]) => v.status !== 'completed')
      .map(([k]) => k);
  } catch {
    // silent: progress 读竞赛/损坏由 caller 按 damaged 候选处理并 audit
    return undefined;
  }
}

function isOnboardingIdentity(contractId: string, title: string | undefined): boolean {
  // title 只用于历史识别；stable id 自身即业务身份（防御 title 漂移）
  return contractId === ONBOARDING_CONTRACT_ID || title === 'Onboarding';
}

/**
 * onboarding 唯一性裁决（0-dep pure，CLI 静态阶段可消费）。
 * 读取顺序不是 authority——只有全集枚举 + 分类后的计数才是。
 */
export function resolveOnboardingIdentity(
  motionDir: string,
  deps: { fsFactory: (baseDir: string) => FileSystem; audit?: AuditLog },
): OnboardingIdentityVerdict {
  const fs = deps.fsFactory(motionDir);
  const candidates: OnboardingCandidate[] = [];

  const auditDamaged = (progressPath: string): void => {
    deps.audit?.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_ONBOARDING_PROGRESS_PARSE_FAILED,
      `path=${progressPath}`,
      'context=resolveOnboardingIdentity',
    );
  };

  // ---- active ----
  if (fs.existsSync(CONTRACT_ACTIVE_DIR)) {
    let entries: string[] = [];
    try {
      entries = fs.listSync(CONTRACT_ACTIVE_DIR, { includeDirs: true }).map(e => e.name);
    } catch { /* silent: TOCTOU race or ENOENT during dir scan */ }
    for (const contractId of entries) {
      const contractRoot = path.join(CONTRACT_ACTIVE_DIR, contractId);
      const contractYaml = path.join(contractRoot, CONTRACT_YAML_FILE);
      const progressJson = path.join(contractRoot, PROGRESS_FILE);
      const published = fs.existsSync(contractYaml) && fs.existsSync(progressJson);
      if (!published) {
        // 未发布 `.creating` claim：stable id 归创建 authority 裁决（不计候选）；
        // 异 id 且 intent 可识别为 onboarding → 未发布候选（fail-closed）；
        // intent 不可读 → 无法判定归属，不识别也不阻塞（不覆盖证据）。
        if (contractId === ONBOARDING_CONTRACT_ID) continue;
        const claimPath = path.join(contractRoot, CREATION_CLAIM_FILE);
        if (!fs.existsSync(claimPath)) continue;
        try {
          const intent = JSON.parse(fs.readSync(claimPath)) as { contract?: { title?: string } };
          if (intent.contract?.title === 'Onboarding') {
            candidates.push({ contractId, location: 'creating', state: 'unpublished', pending: [] });
          }
        } catch { /* silent: 不可读随机 claim 身份不可判定——留证但不冒充 onboarding 候选 */ }
        continue;
      }
      const title = readContractTitle(fs, contractYaml);
      if (!isOnboardingIdentity(contractId, title)) continue;
      const pending = readPendingSubtasks(fs, progressJson);
      if (pending === undefined) {
        auditDamaged(progressJson);
        candidates.push({ contractId, location: 'active', state: 'damaged', pending: [] });
        continue;
      }
      // 与 readOnboardingStatus 语义对齐：active 恒 in_progress（全完成是归档前瞬态）
      candidates.push({ contractId, location: 'active', state: 'in_progress', pending });
    }
  }

  // ---- archive（current state dirs + legacy flat）----
  for (const entry of listArchiveContractLocations({ fs, archiveDir: archiveContainerDir() })) {
    const contractYaml = path.join(entry.contractRoot, CONTRACT_YAML_FILE);
    const progressJson = path.join(entry.contractRoot, PROGRESS_FILE);
    if (!fs.existsSync(contractYaml) || !fs.existsSync(progressJson)) continue;
    const title = readContractTitle(fs, contractYaml);
    if (!isOnboardingIdentity(entry.contractId, title)) continue;
    const pending = readPendingSubtasks(fs, progressJson);
    if (pending === undefined) {
      auditDamaged(progressJson);
      candidates.push({ contractId: entry.contractId, location: 'archive', state: 'damaged', pending: [] });
      continue;
    }
    candidates.push({
      contractId: entry.contractId,
      location: 'archive',
      state: pending.length === 0 ? 'complete' : 'in_progress',
      pending,
    });
  }

  if (candidates.length === 0) return { kind: 'absent' };
  const describe = (c: OnboardingCandidate): string => `${c.location}/${c.contractId}(${c.state})`;
  const damaged = candidates.filter(c => c.state === 'damaged');
  if (damaged.length > 0) {
    return {
      kind: 'conflict',
      candidates: candidates.map(describe),
      detail: `damaged onboarding evidence present: ${damaged.map(describe).join(', ')}`,
    };
  }
  if (candidates.length > 1) {
    return {
      kind: 'conflict',
      candidates: candidates.map(describe),
      detail: `multiple onboarding identities coexist: ${candidates.map(describe).join(', ')}`,
    };
  }
  const only = candidates[0];
  if (only.state === 'unpublished') {
    return {
      kind: 'conflict',
      candidates: [describe(only)],
      detail: `unpublished legacy onboarding creation claim: ${describe(only)}`,
    };
  }
  return {
    kind: 'unique',
    contractId: only.contractId,
    state: only.state === 'complete' ? 'complete' : 'in_progress',
    pending: only.pending,
  };
}
