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
}

/** 凭据引用名合法性（环境变量命名约定）。 */
export function isCredentialRefName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
