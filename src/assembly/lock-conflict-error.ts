/**
 * @module L6.Assembly.LockConflictError
 *
 * Phase 1235: ProcessManager 已删除 LockConflictError（spawn taxonomy 分型为
 * ProcessSpawnConflictError / ProcessGenerationStateError）。Assembly 的死转导出面
 * （本 class + barrel re-export + ASSEMBLE_LOCK_CONFLICT 常量/routing）按计划保留至
 * 下一 phase 统一清退；为不让旧 class 回流 ProcessManager scope，定义自 host 于此。
 * production 零 caller、零 emit，勿在新代码中引用。
 */
export class LockConflictError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, message?: string) {
    super(message ?? `Lock conflict: another process holds the lock at ${lockPath}`);
    this.name = 'LockConflictError';
    this.lockPath = lockPath;
  }
}
