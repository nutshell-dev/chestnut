/**
 * @module L4.ContractSystem.Errors
 * phase 67: ContractSystem typed errors
 */

import type { ArchiveReadIssue } from './types.js';

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
 *   - message: human-readable describe (CLI 渲染参考）
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
 * Phase 1134 Step C / Phase 1193 Step B: archive current-format payload is corrupted or inconsistent.
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
 * Phase 1145 Step B: archive payload reader encountered a typed issue.
 */
export class ContractArchiveReadError extends Error {
  readonly name = 'ContractArchiveReadError';

  constructor(
    message: string,
    public readonly issue: ArchiveReadIssue,
  ) {
    super(message);
  }
}
