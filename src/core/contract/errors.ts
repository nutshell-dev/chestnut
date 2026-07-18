/**
 * @module L4.ContractSystem.Errors
 * phase 67: ContractSystem typed errors
 */

/**
 * phase 957: 检测到多个 active contract 时 fail-closed。
 *
 * 触发：discovery.loadActiveContract 发现 active dir 下存在 >1 个有效 contract。
 * 行为：emit audit 后抛出，强制 caller 先运行 reconciler 解决冲突，不再静默返回 latest。
 */
export class MultipleActiveContractsError extends Error {
  readonly name = 'MultipleActiveContractsError';
  readonly contractIds: string[];

  constructor(message: string, contractIds: string[]) {
    super(message);
    this.contractIds = contractIds;
  }
}

/**
 * phase 67: lockContract TOCTOU race retry budget 用尽 typed Error
 *
 * 触发：高并发场景下、lockContract 自带 retry budget（LOCK_CONTRACT_MAX_RETRY 次）用尽。
 *
 * phase 1121 Step B: process failure 不再 mutate Contract；本 Error 作为 agent-loop
 * crash 类型仍由 EventLoop ack / 错误调度 / fatal audit 处理，但不进入 Contract lifecycle。
 */
export class LockContentionExhaustedError extends Error {
  readonly name = 'LockContentionExhaustedError';
  readonly contractId: string;
  readonly attempts: number;

  constructor(contractId: string, attempts: number) {
    super(`lockContract: TOCTOU race retry exhausted for ${contractId} after ${attempts} attempts`);
    this.contractId = contractId;
    this.attempts = attempts;
  }
}

/**
 * phase 1048: 旧格式单文件锁被存活持有者持有时 fail-closed。
 *
 * 触发：acquireLock 迁移旧格式 progress.lock 时发现持有者 PID 仍存活。
 */
export class LockConflictError extends Error {
  readonly name = 'LockConflictError';
  readonly lockPath: string;

  constructor(lockPath: string, message: string) {
    super(message);
    this.lockPath = lockPath;
  }
}

/**
 * phase 67: contract create input validation typed Error
 *
 * 触发：ContractSystem.create() 内 6 类 yaml validation 失败。
 * CLI 层 catch + format user-friendly multi-line、不再 dump stack trace。
 *
 * 字段:
 *   - field: 'id' | 'subtasks' | 'verification' (语义类别)
 *   - kind: 'empty' | 'already_exists' | 'missing' | 'duplicate' | 'config_missing_field'
 *   - message: human-readable describe (CLI 渲染参考)
 *   - context: 可选额外字段（如 subtaskId / configType）
 */
export class ContractValidationError extends Error {
  readonly name = 'ContractValidationError';
  readonly field: 'id' | 'subtasks' | 'verification';
  readonly kind: 'empty' | 'already_exists' | 'missing' | 'duplicate' | 'config_missing_field';
  readonly context?: Record<string, string>;

  constructor(
    field: ContractValidationError['field'],
    kind: ContractValidationError['kind'],
    message: string,
    context?: Record<string, string>,
  ) {
    super(message);
    this.field = field;
    this.kind = kind;
    this.context = context;
  }
}
