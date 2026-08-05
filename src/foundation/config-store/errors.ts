/**
 * @module L2a.ConfigStore
 *
 * ConfigStore typed failure protocol（phase 1297 Step B）。
 *
 * 所有预期失败一律以 `ConfigStoreError` + discriminated `code` 抛出，
 * 原始异常保留在 `cause`；caller 按 code exhaustive 映射业务文案，
 * 不再解析 message prefix。ConfigStore 不定义任何业务错误措辞。
 */

export type ConfigStoreErrorCode =
  | 'not_found'
  | 'read_failed'
  | 'invalid_yaml'
  | 'missing_env'
  | 'invalid_schema'
  | 'expected_object';

export class ConfigStoreError extends Error {
  constructor(
    readonly code: ConfigStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigStoreError';
  }
}

export function isConfigStoreError(error: unknown): error is ConfigStoreError {
  return error instanceof ConfigStoreError;
}
