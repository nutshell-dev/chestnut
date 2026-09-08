import { formatErr } from '../../foundation/node-utils/index.js';

type PermissionErrorCode =
  | 'PERMISSION_DENIED'
  | 'PATH_NOT_IN_CLAW_SPACE'
  | 'WRITE_OPERATION_FORBIDDEN';

export class PermissionError extends Error {
  readonly code: PermissionErrorCode = 'PERMISSION_DENIED';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();

  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      ...(this.cause !== undefined && { cause: formatErr(this.cause) }),
    };
  }
}

type WriteForbiddenReason = 'system_readonly' | 'outside_allowlist';

export class PathNotInClawSpaceError extends PermissionError {
  readonly code: PermissionErrorCode = 'PATH_NOT_IN_CLAW_SPACE';

  constructor(path: string, clawDir: string) {
    super(
      `Path "${path}" is not within claw root`,
      { path, clawDir }
    );
  }
}

/**
 * phase 1819 (PERMISSIONS-WRITABLE-HINT-DUPLICATES-POLICY): 手写 allowlist 镜像
 * 常量已删除——hint 由 policy owner（claw-permissions.ts）
 * 按当前实例真实 writablePaths 注入，本模块只格式化、不复制 policy。
 * 输入为 owner 的相对 policy 路径（taskSyncDirs 全相对字面量），不做 path.resolve，
 * 不回显绝对路径。
 */
function formatWritableAllowlist(paths: readonly string[]): string {
  return paths.join(', ');
}

function formatWriteForbiddenMessage(
  targetPath: string,
  reason: WriteForbiddenReason,
  allowedPaths?: readonly string[],
): string {
  switch (reason) {
    case 'system_readonly':
      return `Path "${targetPath}" cannot be written: target is a claw system path (read-only)`;
    case 'outside_allowlist': {
      // 稳定前缀（测试锁定 'cannot be written' / 'writable allowlist'）；括号内容 =
      // owner 注入的真实 policy paths。owner 未注入时不回显空括号。
      const hint = allowedPaths && allowedPaths.length > 0
        ? ` (${formatWritableAllowlist(allowedPaths)})`
        : '';
      return `Path "${targetPath}" cannot be written: target is not in claw writable allowlist${hint}`;
    }
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export class WriteOperationForbiddenError extends PermissionError {
  readonly code: PermissionErrorCode = 'WRITE_OPERATION_FORBIDDEN';

  constructor(targetPath: string, reason: WriteForbiddenReason, allowedPaths?: readonly string[]) {
    super(
      formatWriteForbiddenMessage(targetPath, reason, allowedPaths),
      { targetPath, reason }
    );
  }
}
