/**
 * Phase 1817: write 分类与实际 I/O 绑定同一已验证目标（symlink TOCTOU 治理）。
 *
 * checker 通过后 caller 拿裸 path 另行 I/O 时，symlink 可在两步间改指
 * （writable 目标 → claw root 内 system-readonly 目标），FileSystem containment
 * 仍会放行。prepareWrite 在判定时把路径 canonicalize（realpath + 祖先 fallback）、
 * 对 canonical target 做分类，并返回绑定该 target 的 capability——caller 不再
 * 用裸 path 重新 I/O。
 */
export interface GuardedWrite {
  /** 权限判定所作用的 canonical absolute target */
  readonly target: string;
  /** 原子写（temp+rename+fsync，沿用既有 atomic write 协议），绑定 canonical target */
  write(content: string): Promise<void>;
  /** 追加写，绑定 canonical target */
  append(content: string): Promise<void>;
}

export interface PermissionChecker {
  /** Throws if read not allowed */
  checkRead(targetPath: string): void;
  /** Throws if write not allowed */
  checkWrite(targetPath: string): void;
  /** Resolves relative path + checks operation; returns absolute path */
  resolveAndCheck(relativePath: string, operation: 'read' | 'write'): string;
  /**
   * Phase 1817: resolve + 对 canonical target 分类 + 返回绑定该 target 的写 capability。
   * write 路径的唯一入口——caller 不得 check 后另用裸 path I/O。
   * @throws PermissionError 分类 deny 时与 checkWrite 同一 vocabulary
   */
  prepareWrite(relativePath: string): Promise<GuardedWrite>;
}
