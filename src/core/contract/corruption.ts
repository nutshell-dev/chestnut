/**
 * @module L4.ContractSystem.Corruption
 * phase 1862 Step E (CT-D6): corrupted 判定单一解释层。
 *
 * 处置分界（判据显式化）：
 * - schema 类（JSON/YAML parse 失败、zod safeParse 失败）→ 'isolate'
 *   （不可恢复重建：原文件即损坏事实，隔离后按 corrupted 终态处置）
 * - FNF（读取期竞态）→ 'retryable_io'（不隔离、可重读）
 * - 权限等（EACCES/EPERM 及其他 I/O）→ 'fatal'（不可自愈；调用方按既有降级处置）
 *
 * 本 step 仅收敛判定入口：各消费点处置行为零漂移（reason 词汇表与 audit
 * 输出逐字保持）。guidance wire decode（ContractEventsGuidanceDecodeError 等）
 * 非文件 corruption，不纳入本层（计划 §7 边界）。
 */

import { isFileNotFound } from '../../foundation/fs/index.js';

/** 处置分界：isolate（schema 类）/ retryable_io（瞬时）/ fatal（不可自愈）。 */
export type CorruptionDisposition = 'isolate' | 'retryable_io' | 'fatal';

export interface CorruptionClassification {
  readonly disposition: CorruptionDisposition;
  /** 归一 reason（evidence 词汇表：progress_* / yaml_*）。 */
  readonly reason: string;
}

export type CorruptionKind = 'yaml' | 'progress' | 'lock';

function isErrno(err: unknown, ...codes: readonly string[]): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    codes.includes((err as NodeJS.ErrnoException).code ?? '')
  );
}

/**
 * 单一判定入口（thrown-error 面）：
 * - SyntaxError（JSON.parse 失败）→ isolate（reason 按 kind 归一）
 * - FNF → retryable_io（不隔离、可重读）
 * - EACCES / EPERM → fatal（权限不可自愈）
 * - 其他 I/O → fatal
 */
export function classifyCorruption(
  err: unknown,
  ctx: { kind: CorruptionKind },
): CorruptionClassification {
  // parse 类：JSON.parse SyntaxError + js-yaml YAMLException（name 判定，
  // YAMLException 不继承 SyntaxError）。
  const isParseClass =
    err instanceof SyntaxError || (err instanceof Error && err.name === 'YAMLException');
  if (isParseClass) {
    return {
      disposition: 'isolate',
      reason: ctx.kind === 'progress' ? 'progress_json_parse_error' : `${ctx.kind}_parse_error`,
    };
  }
  if (isFileNotFound(err)) {
    return { disposition: 'retryable_io', reason: 'file_not_found_race' };
  }
  if (isErrno(err, 'EACCES', 'EPERM')) {
    return { disposition: 'fatal', reason: 'permission_denied' };
  }
  return { disposition: 'fatal', reason: 'io_error' };
}

/**
 * safeParse 失败判定（schema 事实面）：
 * - progress：首 issue 路径为 schema_version → 'progress_unknown_schema_version'
 *   （本模块无法解释未来 schema = 不可恢复），其余 → 'progress_schema_invalid'
 * - yaml / lock：'yaml_schema_invalid' / 'schema_invalid'（既有词汇表无版本区分）
 */
export function classifySchemaViolation(
  kind: CorruptionKind,
  firstIssuePath: string | number | undefined,
): CorruptionClassification {
  if (kind === 'progress') {
    return firstIssuePath === 'schema_version'
      ? { disposition: 'isolate', reason: 'progress_unknown_schema_version' }
      : { disposition: 'isolate', reason: 'progress_schema_invalid' };
  }
  if (kind === 'yaml') {
    return { disposition: 'isolate', reason: 'yaml_schema_invalid' };
  }
  return { disposition: 'isolate', reason: 'schema_invalid' };
}

/**
 * evidence reason → 隔离 audit reason 的单一映射（历史词汇表保持）：
 * progress_unknown_schema_version → 'unknown_schema_version'；
 * progress_schema_invalid → 'schema_invalid'；
 * progress_json_parse_error → 'json_parse_error'；
 * 其余（yaml_* 等）原样。
 */
export function isolationReasonFor(classification: CorruptionClassification): string {
  switch (classification.reason) {
    case 'progress_unknown_schema_version':
      return 'unknown_schema_version';
    case 'progress_schema_invalid':
      return 'schema_invalid';
    case 'progress_json_parse_error':
      return 'json_parse_error';
    default:
      return classification.reason;
  }
}
