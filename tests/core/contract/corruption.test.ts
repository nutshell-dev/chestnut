/**
 * phase 1862 Step E (CT-D6): corruption 单一解释层 classify 单测。
 *
 * 判据分界显式断言：
 * - schema 类（SyntaxError / YAMLException / safeParse 失败）→ isolate
 * - FNF 竞态 → retryable_io
 * - EACCES / EPERM / 其他 I/O → fatal
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCorruption,
  classifySchemaViolation,
  isolationReasonFor,
} from '../../../src/core/contract/corruption.js';

function errno(code: string): Error {
  const err = new Error(`mock ${code}`);
  (err as NodeJS.ErrnoException).code = code;
  return err;
}

describe('classifyCorruption (thrown-error 面)', () => {
  it('JSON.parse SyntaxError (progress) → isolate / progress_json_parse_error', () => {
    expect(classifyCorruption(new SyntaxError('bad json'), { kind: 'progress' })).toEqual({
      disposition: 'isolate',
      reason: 'progress_json_parse_error',
    });
  });

  it('js-yaml YAMLException (yaml) → isolate / yaml_parse_error', () => {
    const yamlErr = new Error('bad yaml');
    yamlErr.name = 'YAMLException';
    expect(classifyCorruption(yamlErr, { kind: 'yaml' })).toEqual({
      disposition: 'isolate',
      reason: 'yaml_parse_error',
    });
  });

  it('FNF (读取期竞态) → retryable_io（不隔离、可重读）', () => {
    expect(classifyCorruption(errno('ENOENT'), { kind: 'progress' })).toEqual({
      disposition: 'retryable_io',
      reason: 'file_not_found_race',
    });
  });

  it('EACCES / EPERM → fatal（权限不可自愈）', () => {
    expect(classifyCorruption(errno('EACCES'), { kind: 'progress' }).disposition).toBe('fatal');
    expect(classifyCorruption(errno('EPERM'), { kind: 'yaml' })).toEqual({
      disposition: 'fatal',
      reason: 'permission_denied',
    });
  });

  it('其他 I/O (EIO) → fatal / io_error', () => {
    expect(classifyCorruption(errno('EIO'), { kind: 'lock' })).toEqual({
      disposition: 'fatal',
      reason: 'io_error',
    });
  });
});

describe('classifySchemaViolation (safeParse schema 事实面)', () => {
  it('progress 首 issue 路径 = schema_version → isolate / progress_unknown_schema_version（不可恢复）', () => {
    expect(classifySchemaViolation('progress', 'schema_version')).toEqual({
      disposition: 'isolate',
      reason: 'progress_unknown_schema_version',
    });
  });

  it('progress 其他路径 → isolate / progress_schema_invalid', () => {
    expect(classifySchemaViolation('progress', 'subtasks')).toEqual({
      disposition: 'isolate',
      reason: 'progress_schema_invalid',
    });
  });

  it('yaml → isolate / yaml_schema_invalid（既有词汇表无版本区分）', () => {
    expect(classifySchemaViolation('yaml', 'schema_version')).toEqual({
      disposition: 'isolate',
      reason: 'yaml_schema_invalid',
    });
  });

  it('lock → isolate / schema_invalid', () => {
    expect(classifySchemaViolation('lock', undefined)).toEqual({
      disposition: 'isolate',
      reason: 'schema_invalid',
    });
  });
});

describe('isolationReasonFor（evidence → 隔离 audit reason 单一映射）', () => {
  it.each([
    ['progress_unknown_schema_version', 'unknown_schema_version'],
    ['progress_schema_invalid', 'schema_invalid'],
    ['progress_json_parse_error', 'json_parse_error'],
    ['yaml_parse_error', 'yaml_parse_error'],
    ['yaml_schema_invalid', 'yaml_schema_invalid'],
  ] as const)('%s → %s', (reason, expected) => {
    expect(isolationReasonFor({ disposition: 'isolate', reason })).toBe(expected);
  });
});
