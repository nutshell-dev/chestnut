/**
 * @module L4.ContractSystem.Errors
 * phase 67: ContractSystem typed errors
 */

import type { ContractId } from './types.js';

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
 * phase 1127 Step B: contract 出现在多个 current/legacy archive 位置时 fail-closed。
 *
 * 触发：resolveContractLocation 发现同一个 contract id 同时存在于 active、状态子目录或 legacy flat。
 */
export class ContractLocationAmbiguityError extends Error {
  readonly name = 'ContractLocationAmbiguityError';
  readonly contractId: string;
  readonly locations: string[];

  constructor(contractId: string, locations: string[]) {
    super(`Contract "${contractId}" exists in multiple locations: ${locations.join(', ')}`);
    this.contractId = contractId;
    this.locations = locations;
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

/**
 * phase 1130 Step C: active capacity exhausted typed error.
 *
 * Triggered by ContractSystem.create when a physical active contract directory
 * already exists. Carries the requested id and all active ids (stable sorted).
 */
export class ContractCapacityError extends Error {
  readonly name = 'ContractCapacityError';
  readonly activeContractIds: ContractId[];

  constructor(
    readonly requestedContractId: ContractId,
    activeContractIds: readonly ContractId[],
  ) {
    super(`Cannot create contract "${requestedContractId}": active capacity is full`);
    this.activeContractIds = [...activeContractIds].sort();
  }
}

/**
 * Phase 1134 Step C: new-layout active/current slot is corrupted or inconsistent.
 */
export class ContractLayoutCorruptedError extends Error {
  readonly name = 'ContractLayoutCorruptedError';

  constructor(
    message: string,
    public readonly context: { root: string; cause: string; [key: string]: unknown },
  ) {
    super(message);
  }
}

/**
 * Phase 1134 Step D: concurrent commit lost the race for the fixed active/current slot.
 */
export class ActiveContractSlotOccupiedError extends Error {
  readonly name = 'ActiveContractSlotOccupiedError';

  constructor(
    public readonly currentPath: string,
    public readonly attemptedCreationId: string,
    public readonly causeError?: unknown,
  ) {
    super(
      `active contract slot already occupied at "${currentPath}" ` +
      `(attempted creationId=${attemptedCreationId})`,
    );
  }
}

/**
 * Phase 1134 Step D: staging directory could not be prepared or read back cleanly.
 */
export class ContractStagingCorruptedError extends Error {
  readonly name = 'ContractStagingCorruptedError';

  constructor(
    message: string,
    public readonly context: { creationId: string; root: string; cause: string; [key: string]: unknown },
  ) {
    super(message);
  }
}
