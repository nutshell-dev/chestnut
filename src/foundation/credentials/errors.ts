/**
 * @module L2a.Credentials
 *
 * Credentials typed failure protocol（Phase 1925 Step B）。
 *
 * 预期失败一律以 `CredentialsError` + discriminated `code` 抛出，原始异常保留
 * 在 `cause`；错误消息自带修复建议（如 chmod 600）。永不携带 secret 值。
 */

export type CredentialsErrorCode =
  | 'invalid_ref'      // ref 名不合法（非环境变量命名约定）
  | 'empty_value'      // set 空值（空值处处视为缺席，写入无意义）
  | 'shadowed_by_env'  // 进程环境已提供同名值（env 优先语义下写入无意义）
  | 'permissions'      // 凭据文件带 group/other 权限位（读路径 loud 拒绝）
  | 'io_error';        // 读/写/解析失败（含凭据文件结构非法）

/** 单行 unknown error 格式化（同 ConfigStore 先例，不展开 cause 链）。 */
function formatCause(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const head = error.message || error.name || 'Error';
    return code ? `[${code}] ${head}` : head;
  }
  return String(error);
}

export class CredentialsError extends Error {
  constructor(
    readonly code: CredentialsErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CredentialsError';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.cause !== undefined && { cause: formatCause(this.cause) }),
    };
  }
}

export function isCredentialsError(error: unknown): error is CredentialsError {
  return error instanceof CredentialsError;
}
