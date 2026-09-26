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
// Phase 1912 Step E（RACE-ONBOARDING-CROSS-ID，业务边界用户裁决）：
// `title: Onboarding` 不是全系统唯一业务身份——title 是展示字段，不是身份
// 字段；onboarding 的稳定身份只有 motion 流程内的 ONBOARDING_CONTRACT_ID。
// 历史随机 id 的 title 匹配因此降级为「迁移候选/冲突检测」线索：
// - stable id 候选（按 id 判定，防御 title 漂移）是唯一可复用身份；
// - 随机 id title=Onboarding（已发布或未发布 claim）= 歧义迁移候选：无法
//   区分旧版 onboarding 与用户同名普通合同 → 一律 conflict，停止自动采用；
// - 通用 create 入口建同名 title 属用户自由（caller-owned policy），不在此
//   全局拒绝；但 start 在歧义证据下 fail-closed，同名合同不得冒充 start
//   onboarding。
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
  /**
   * Phase 1912 Step E：stable = 稳定业务身份（按 id 判定）；migration = 随机 id
   * title 匹配的歧义迁移候选（只做冲突检测线索，不作自动采用 authority）。
   */
  readonly identity: 'stable' | 'migration';
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

/**
 * 候选分类（Phase 1912 Step E）：stable id 自身即业务身份（防御 title 漂移）；
 * 随机 id 的 title=Onboarding 只是迁移识别线索，不是身份。
 */
function classifyOnboardingCandidate(
  contractId: string,
  title: string | undefined,
): 'stable' | 'migration' | undefined {
  if (contractId === ONBOARDING_CONTRACT_ID) return 'stable';
  if (title === 'Onboarding') return 'migration';
  return undefined;
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
        // 异 id 且 intent title=Onboarding → 歧义迁移候选（fail-closed）；
        // intent 不可读 → 无法判定归属，不识别也不阻塞（不覆盖证据）。
        if (contractId === ONBOARDING_CONTRACT_ID) continue;
        const claimPath = path.join(contractRoot, CREATION_CLAIM_FILE);
        if (!fs.existsSync(claimPath)) continue;
        try {
          const intent = JSON.parse(fs.readSync(claimPath)) as { contract?: { title?: string } };
          if (intent.contract?.title === 'Onboarding') {
            candidates.push({ contractId, location: 'creating', state: 'unpublished', pending: [], identity: 'migration' });
          }
        } catch { /* silent: 不可读随机 claim 身份不可判定——留证但不冒充 onboarding 候选 */ }
        continue;
      }
      const title = readContractTitle(fs, contractYaml);
      const identity = classifyOnboardingCandidate(contractId, title);
      if (!identity) continue;
      const pending = readPendingSubtasks(fs, progressJson);
      if (pending === undefined) {
        auditDamaged(progressJson);
        candidates.push({ contractId, location: 'active', state: 'damaged', pending: [], identity });
        continue;
      }
      // 与 readOnboardingStatus 语义对齐：active 恒 in_progress（全完成是归档前瞬态）
      candidates.push({ contractId, location: 'active', state: 'in_progress', pending, identity });
    }
  }

  // ---- archive（current state dirs + legacy flat）----
  for (const entry of listArchiveContractLocations({ fs, archiveDir: archiveContainerDir() })) {
    const contractYaml = path.join(entry.contractRoot, CONTRACT_YAML_FILE);
    const progressJson = path.join(entry.contractRoot, PROGRESS_FILE);
    if (!fs.existsSync(contractYaml) || !fs.existsSync(progressJson)) continue;
    const title = readContractTitle(fs, contractYaml);
    const identity = classifyOnboardingCandidate(entry.contractId, title);
    if (!identity) continue;
    const pending = readPendingSubtasks(fs, progressJson);
    if (pending === undefined) {
      auditDamaged(progressJson);
      candidates.push({ contractId: entry.contractId, location: 'archive', state: 'damaged', pending: [], identity });
      continue;
    }
    candidates.push({
      contractId: entry.contractId,
      location: 'archive',
      state: pending.length === 0 ? 'complete' : 'in_progress',
      pending,
      identity,
    });
  }

  if (candidates.length === 0) return { kind: 'absent' };
  const describe = (c: OnboardingCandidate): string => `${c.location}/${c.contractId}(${c.state})`;
  const conflict = (detail: string): OnboardingIdentityVerdict => ({
    kind: 'conflict',
    candidates: candidates.map(describe),
    detail,
  });
  const damaged = candidates.filter(c => c.state === 'damaged');
  if (damaged.length > 0) {
    return conflict(`damaged onboarding evidence present: ${damaged.map(describe).join(', ')}`);
  }

  // Phase 1912 Step E：stable id 是唯一可复用身份；随机 id title 匹配只做
  // 迁移候选/冲突检测——无法区分旧版 onboarding 与用户同名普通合同，停止
  // 自动采用，报告冲突并保留证据。
  const stable = candidates.filter(c => c.identity === 'stable');
  const migrations = candidates.filter(c => c.identity === 'migration');
  const MIGRATION_GUIDANCE =
    'title is a display field, not an identity; cannot distinguish a legacy ' +
    'onboarding contract from a user contract with the same title, auto-adoption stopped; ' +
    `resolve manually (archive/remove the legacy one, or rename the user contract's title) and retry`;
  if (stable.length > 0 && migrations.length > 0) {
    return conflict(
      `stable onboarding identity coexists with ambiguous title-matched contract(s): ` +
      `${migrations.map(describe).join(', ')}; ${MIGRATION_GUIDANCE}`,
    );
  }
  if (migrations.length > 0) {
    const multiple = migrations.length > 1 ? 'multiple ' : '';
    return conflict(
      `${multiple}ambiguous onboarding migration candidate(s): ${migrations.map(describe).join(', ')}; ${MIGRATION_GUIDANCE}`,
    );
  }
  const only = stable[0];
  return {
    kind: 'unique',
    contractId: only.contractId,
    state: only.state === 'complete' ? 'complete' : 'in_progress',
    pending: only.pending,
  };
}
