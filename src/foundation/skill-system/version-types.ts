/**
 * Phase 1919 Step B: dispatch 技能版本服务类型契约（L2c.SkillSystem）。
 *
 * SkillSystem 拥有的 dispatch 技能版本能力：正式发布/读取入口统一经本服务，
 * 所有消费者获得提交版本。git 分支/提交/CAS/导出原语归 Snapshot VersionStore
 * （L2a）；本服务只理解技能名、路径前缀、版本标识与调用方依据，不理解
 * Motion/EvolutionSystem/summon/retro 业务语义（依据是不透明记录）。
 *
 * 磁盘归属（caller 装配责任，均在 Motion 可访问的 clawspace 内）：
 * - repositoryDir：dispatch 版本库根（独立 Git 根，`.git` 归 Snapshot 管理）；
 *   库根工作区只是历史遗留投影，不是读取权威
 * - workspaceParent：候选编辑工作区 parent（不被扫描为技能、不被清扫）
 * - stateDir：服务自有状态（迁移记录/技能清单/投影清单/固定版本物化投影）
 */

/** 调用方依据：谁、为什么、来源引用。不透明持久化进发布记录，模块不解释内容。 */
export interface SkillBasis {
  actor: string;
  reason: string;
  sourceRefs: readonly string[];
}

/** 固定版本读取结果：materializedPath 为该版本物化投影的绝对路径（只读消费）。 */
export interface PublishedSkill {
  name: string;
  /** 该技能最近一次发布变更的版本身份（VersionId 字符串形态） */
  sourceVersion: string;
  materializedPath: string;
}

export type SkillPublishResult =
  | { kind: 'published'; version: string }
  /** 技能路径基准已过期：current 为当前 published，retainedCandidate 为保留的候选版本 */
  | { kind: 'conflict'; current: string; retainedCandidate: string }
  /** CAS 有界重试耗尽；同 operationId 重试可续作 */
  | { kind: 'busy'; operationId: string };

export interface ImportSkillInput {
  /** 发布目标技能名（版本库顶层前缀；与 source 目录名解耦——调用方可从暂存快照发布） */
  name: string;
  /** 不可变技能源目录绝对路径（含 SKILL.md；快照/暂存由调用方负责） */
  source: string;
  /** 幂等键：同一 operationId 重试返回首次操作事实；输入漂移 typed 拒绝 */
  operationId: string;
  basis: SkillBasis;
}

export interface SkillVersions {
  /** 读取某技能的已发布固定版本（物化投影 + 版本身份）；未发布 typed not_found */
  readPublished(name: string): Promise<PublishedSkill>;
  /** 读取已发布版本的 SKILL.md 正文（与 readPublished 同一固定版本） */
  loadPublished(name: string): Promise<string>;
  /** 全部已发布技能的上下文摘要（格式唯一 owner = 既有 registry 解析/格式化） */
  formatPublishedForContext(): Promise<string>;
  /**
   * 导入技能为正式版本：从最新 published 开分支 → 保存候选 → 按技能路径条件发布。
   * 冲突保留候选并返回 current/retry 信号，不覆盖他人已发布版本。
   */
  importSkill(input: ImportSkillInput): Promise<SkillPublishResult>;
}

export type SkillVersionErrorKind =
  /** 参数契约错误（技能名/source/basis/operationId 校验失败） */
  | 'invalid_argument'
  /** 技能从未发布 */
  | 'not_found'
  /** 发现旧活动 intent/marker/staging：必须先恢复，不能绕过迁移 */
  | 'migration_blocked'
  /** 版本库已存在但无迁移状态（非本服务创建）：loud 拒绝，不覆盖 */
  | 'baseline_failed'
  /** 固定版本物化投影同步失败（已发布事实不受影响，保留旧投影） */
  | 'sync_failed'
  /** 服务自有状态/操作记录损坏：loud 拒绝，不伪造事实 */
  | 'store_error';

export class SkillVersionError extends Error {
  readonly kind: SkillVersionErrorKind;
  /** migration_blocked 等场景的发现证据（相对路径列表） */
  readonly evidence: readonly string[];

  constructor(kind: SkillVersionErrorKind, message: string, options?: { cause?: unknown; evidence?: readonly string[] }) {
    super(message, options);
    this.name = 'SkillVersionError';
    this.kind = kind;
    this.evidence = options?.evidence ?? [];
  }
}
