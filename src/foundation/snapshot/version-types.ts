/**
 * Phase 1918 Step B: Snapshot 通用版本库类型契约。
 *
 * 与 Snapshot（自动快照 init/commit）正交：本族类型承载「独立目录版本库」的
 * 显式版本操作。Step B 冻结最小接口（分支工作区 begin/save）；按路径条件发布
 * （publish）与固定版本读取/导出/恢复在 Step C / Step D 顺序扩展本文件。
 * 模块只理解路径、版本标识与不透明操作元数据，不理解 skill / dispatch /
 * summon / 复盘等业务语义。
 */

/**
 * 版本标识（git commit oid）。只能由 VersionStore 内部验证过的对象解析产生，
 * 调用方不得自行拼造；跨重启可持久保存并按字符串原样回传。
 */
export type VersionId = string & { readonly __brand: 'VersionId' };

/**
 * 幂等键：同一 operationId 的重试必须返回相同持久结果；
 * 以不同输入复用同一 operationId 是调用方契约错误（invalid_argument）。
 */
export type OperationId = string;

/** 分支工作区句柄。path 为绝对路径；branch 为库内持有的持久候选 ref。 */
export interface EditWorkspace {
  id: string;
  base: VersionId;
  path: string;
  branch: string;
}

export interface VersionStore {
  begin(input: { operationId: OperationId; base: VersionId }): Promise<EditWorkspace>;
  save(input: { workspaceId: string; operationId: OperationId; message: string }): Promise<VersionId>;
}

export type VersionStoreErrorKind =
  /** 参数契约错误（prefix/version/message/metadata/operationId 校验失败、幂等键输入漂移） */
  | 'invalid_argument'
  /** 仓库归属/形态校验失败（外来 .git、非独立根、非 sha1） */
  | 'repo_invalid'
  /** git init / 初始提交失败（现场保留，绝不清理 .git） */
  | 'repo_init_failed'
  | 'unknown_workspace'
  | 'unknown_version'
  /** 目标 prefix 在该版本不存在 */
  | 'not_found'
  /** 候选改了 prefix 外路径（候选保留，publish 以抛错拒绝） */
  | 'candidate_out_of_scope'
  /** 持久操作记录损坏或与仓库事实矛盾 */
  | 'record_corrupt'
  /** 工作区分支在 save 期间被并发推进 */
  | 'save_conflict'
  /** export 符号链接越界（绝对链接或逃逸导出根） */
  | 'symlink_escape'
  /** export 遇到无法物化的条目（gitlink 等） */
  | 'unsupported_entry'
  /** 其他 git 失败（非 CAS 语义、非 lock 竞争误判） */
  | 'git_error';

export class VersionStoreError extends Error {
  readonly kind: VersionStoreErrorKind;

  constructor(kind: VersionStoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VersionStoreError';
    this.kind = kind;
  }
}
