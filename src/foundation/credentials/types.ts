/**
 * @module L2a.Credentials
 * @layer L2 基础层
 *
 * 用户级 Credentials owner 类型契约（Phase 1925 Step B）。
 *
 * 配置只保存 `${VAR}` reference；值由本 owner 分层解析：
 * 进程环境（只读、最高）> 用户级凭据文件（唯一可写层）> 项目 .env（只读回退）
 * > 用户级 .env（只读回退）。空值处处视为缺席。
 * describe/日志永不返回 secret 值。
 */

/** 命中层。'file' = 用户级凭据文件（唯一可写层）。 */
export type CredentialSource = 'env' | 'file' | 'project-env' | 'user-env';

/** resolve 命中结果（含值 — 仅 resolve 返回 secret）。 */
export interface ResolvedCredential {
  value: string;
  source: CredentialSource;
}

/**
 * describe 结果（永不携带 secret 值，供 audit/UI 展示）。
 * writable 仅当 source==='file' 或完全未配置且无 env shadow 时为 true。
 */
export interface CredentialInfo {
  configured: boolean;
  source?: CredentialSource;
  writable: boolean;
}

/**
 * Credentials owner。
 * resolve/describe 同步（config 加载链路是同步的），每次调用重读文件不缓存
 * （外部编辑下一次 resolve 可见）；set/unset 异步（跨进程锁内重读 + 原子发布）。
 */
export interface CredentialsOwner {
  resolve(ref: string): ResolvedCredential | undefined;
  describe(ref: string): CredentialInfo;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  /**
   * Phase 1927 Step E：跨进程 read-modify-write 事务（F3 修复）。
   *
   * 完整闭包在凭据文件锁内执行：锁内重读当前文件层值 → fn（可含网络调用，
   * 如 OAuth refresh/login 决策）→ 按返回值写回（undefined = 删除）→ 原子
   * 发布。迟到 writer 不可能覆盖另一进程的提交（fn 看到的是锁内最新值）。
   * - fn 收到的是**文件层**当前值（唯一可写层；env shadow 先行拒绝——写无意义）；
   * - fn 返回 '' → typed 'empty_value'（空值缺席语义不变）；
   * - fn 抛错 → 不写回、原错误穿透（锁照常释放，释放失败显式报告）；
   * - 死 holder 由锁的活性探测回收（PID+启动时间）；获取超时 typed 'lock_timeout'。
   */
  modify(
    ref: string,
    fn: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined>;
}

/** 凭据引用名合法性（环境变量命名约定）。 */
export function isCredentialRefName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
