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

// ========================================================================
// Phase 1919 Step C：技能分支编辑事务（begin/submit/retry/cancel/status/history）
// ========================================================================

export interface BeginEditInput {
  /** 编辑目标技能名（版本库顶层前缀；尚无已发布版本即新建） */
  skillName: string;
  /** 幂等键：同一 requestId 重放返回首次编辑事实（editId 由 requestId 确定性派生）；输入漂移 typed 拒绝 */
  requestId: string;
  basis: SkillBasis;
}

/** 分支编辑工作区句柄：path 为工作区内该技能子树的绝对路径（新建技能时由编辑方创建）。 */
export interface SkillEditHandle {
  editId: string;
  skillName: string;
  /** 工作区内技能子树绝对路径（<workspaceParent>/<workspaceId>/<skillName>） */
  path: string;
  /** 编辑基准（begin 时刻的整库 published 版本身份） */
  base: string;
  /** 基准时刻该技能路径版本（pathRevision(base, skillName)；null = 尚无已发布版本） */
  basePathRevision: string | null;
}

/**
 * 编辑事务状态（全部可从事务记录重建，不依赖内存句柄）：
 * - preparing：记录已落盘、分支工作区未就绪（崩溃窗口；同 requestId 重放续作）
 * - editing：工作区就绪、候选未保存
 * - saved：候选已保存、发布未决（含 busy 待重试；publishOperationId 持久在场）
 * - published：条件发布成功（version 在场）
 * - conflict：技能路径基准过期（current 在场，候选保留，绝不覆盖/删除）
 * - cancelled：已取消（可保存内容已先保存为候选）
 */
export type SkillEditStatus = 'preparing' | 'editing' | 'saved' | 'published' | 'conflict' | 'cancelled';

export type SubmitEditResult =
  | { kind: 'published'; editId: string; version: string }
  /** 技能路径基准已过期：base 为编辑基准，current 为当前 published，candidate 为保留候选 */
  | { kind: 'conflict'; editId: string; base: string; current: string; candidate: string }
  /** CAS 有界重试耗尽：持久呈现为待重试（候选与 publishOperationId 保留），不得伪装成语义冲突 */
  | { kind: 'busy'; editId: string; operationId: string };

/** 编辑事务持久事实视图（status/history 返回；按状态呈现 version/current，不伪造） */
export interface SkillEditInfo {
  editId: string;
  requestId: string;
  skillName: string;
  base: string;
  basePathRevision: string | null;
  /** 保存候选版本身份（未保存为 null；published/conflict/cancelled 后长期可达） */
  candidate: string | null;
  status: SkillEditStatus;
  /** retry 链：本编辑由哪个冲突编辑派生（首轮为 null） */
  parentEditId: string | null;
  /** saved（发布未决）时在场：稳定发布幂等键，业务状态可经 Snapshot 操作记录重建 */
  publishOperationId: string | null;
  /** published：发布版本身份；其他状态 null */
  version: string | null;
  /** conflict：当前 published 版本身份；其他状态 null */
  current: string | null;
  basis: SkillBasis;
  createdAt: string;
  updatedAt: string;
}

export interface RetryEditInput {
  /** 处于 conflict 的旧编辑 id（其他状态 typed 拒绝） */
  editId: string;
  /** 新编辑的幂等键（不得复用旧 requestId；输入漂移 typed 拒绝） */
  requestId: string;
}

/** Phase 1919 Step F：安装来源 pinning 的按版本导出输入 */
export interface ExportSkillVersionInput {
  /** 技能名（版本库顶层前缀） */
  name: string;
  /** 已发布版本身份（40-hex commit；来源选定后跨重启不变） */
  version: string;
  /** 独占空目标绝对目录（覆盖同名文件、不清理多余文件；不得在版本库内） */
  destination: string;
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

  // ---- Phase 1919 Step C：技能分支编辑事务 ----

  /**
   * 开启分支编辑事务：从最新 published 开工作区分支并持久化事务记录
   * （记录先于工作区落盘，中断可重建）。同 requestId 重放返回首次编辑事实
   * （preparing 中断续作）；不自动携带任何旧候选字节。
   */
  beginEdit(input: BeginEditInput): Promise<SkillEditHandle>;
  /**
   * 提交编辑：保存候选 → 验证候选只含合法 SKILL.md（范围违规/校验失败候选仍保留，
   * typed 拒绝）→ 按 begin 时技能路径基准条件发布。重复 submit（含重启后）返回
   * 首次发布事实；busy 持久呈现为待重试（同 editId 重提续作）。
   */
  submitEdit(editId: string): Promise<SubmitEditResult>;
  /**
   * 冲突重做：从最新 published 新建分支并链接旧编辑（parentEditId），依据沿用旧
   * 记录。绝不 reset 原分支、不自动 merge、不把旧候选（哪怕只改依据）自动强推。
   */
  retryEdit(input: RetryEditInput): Promise<SkillEditHandle>;
  /** 取消编辑：先保存可保存内容为候选再登记 cancelled；保存失败 loud 拒绝并保留工作区 */
  cancelEdit(editId: string): Promise<SkillEditInfo>;
  /** 事务状态查询（重启后准确；saved + publishOperationId 经 Snapshot 操作记录自愈对账） */
  editStatus(editId: string): Promise<SkillEditInfo>;
  /** 事务历史（新→旧；skillName 缺席返回全部技能） */
  editHistory(skillName?: string): Promise<readonly SkillEditInfo[]>;

  // ---- Phase 1919 Step F：安装来源版本固定 ----

  /**
   * 导出指定已发布版本的技能子树到独占空目录（安装 pinning：来源 commit 选定后
   * 跨重启/并发发布不变）。commit 缺失/损坏 typed 失败（不回退 live）；
   * version 必须是 40-hex commit 身份。
   */
  exportSkillVersion(input: ExportSkillVersionInput): Promise<void>;
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
