/**
 * Phase 1297 Step C: ConfigStore owner 行为测试。
 *
 * 直接经 ConfigStore public barrel 冻结 generic YAML persistence 契约：
 * load/write/patch/exists 全部能力与六类 typed failure variant
 * （instanceof + code + cause）。不经过 Assembly 业务 wrapper；
 * Assembly 业务文案/schema 断言仍留在 tests/foundation/config/crud.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import * as yaml from 'js-yaml';

import {
  loadYamlConfig,
  writeYamlConfig,
  patchYamlConfig,
  configExists,
  ConfigStoreError,
  isConfigStoreError,
  type ConfigSchema,
  type ConfigStoreErrorCode,
} from '../../../src/foundation/config-store/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

interface TestConfig {
  name: string;
  retries?: number;
}

/** 手写 schema：ConfigStore 只要求 { parse } 契约，不依赖任何 schema 库。 */
const testSchema: ConfigSchema<TestConfig> = {
  parse(data: unknown): TestConfig {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('schema: expected object');
    }
    const rec = data as Record<string, unknown>;
    if (typeof rec.name !== 'string') {
      throw new Error('schema: name must be a string');
    }
    const cfg: TestConfig = { name: rec.name };
    if (rec.retries !== undefined) {
      if (typeof rec.retries !== 'number') {
        throw new Error('schema: retries must be a number');
      }
      cfg.retries = rec.retries;
    }
    return cfg;
  },
};

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tempDir: string;
let configPath: string;

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `config-store-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  configPath = path.join(tempDir, 'config.yaml');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** 断言 fn 抛出指定 code 的 ConfigStoreError 并返回该错误。 */
function catchStoreError(fn: () => unknown, code: ConfigStoreErrorCode): ConfigStoreError {
  try {
    fn();
  } catch (err) {
    expect(isConfigStoreError(err)).toBe(true);
    expect(err).toBeInstanceOf(ConfigStoreError);
    expect((err as ConfigStoreError).code).toBe(code);
    return err as ConfigStoreError;
  }
  throw new Error(`expected ConfigStoreError with code "${code}"`);
}

describe('config-store: loadYamlConfig', () => {
  it('load success: YAML parse + schema typed result', () => {
    fs.writeFileSync(configPath, 'name: chestnut\nretries: 3\n');
    expect(loadYamlConfig({ fsFactory }, configPath, testSchema)).toEqual({
      name: 'chestnut',
      retries: 3,
    });
  });

  it('schema 不注入 caller 未提供的字段（无 default 注入）', () => {
    fs.writeFileSync(configPath, 'name: chestnut\n');
    expect(loadYamlConfig({ fsFactory }, configPath, testSchema)).toEqual({ name: 'chestnut' });
  });

  it('env expansion: object/array/string 递归展开', () => {
    vi.stubEnv('CS_STRING', 'str-value');
    vi.stubEnv('CS_NESTED', 'nested-value');
    vi.stubEnv('CS_ITEM', 'item-value');
    fs.writeFileSync(configPath, [
      'name: ${CS_STRING}',
      'nested:',
      '  key: ${CS_NESTED}',
      'list:',
      '  - ${CS_ITEM}',
      '  - plain',
      '',
    ].join('\n'));

    const schema: ConfigSchema<Record<string, unknown>> = {
      parse: (data) => data as Record<string, unknown>,
    };
    expect(loadYamlConfig({ fsFactory }, configPath, schema)).toEqual({
      name: 'str-value',
      nested: { key: 'nested-value' },
      list: ['item-value', 'plain'],
    });
  });

  it('missing env: code missing_env，变量名保留在 message 与 cause', () => {
    fs.writeFileSync(configPath, 'name: ${CS_DEFINITELY_UNSET_VAR}\n');
    const err = catchStoreError(
      () => loadYamlConfig({ fsFactory }, configPath, testSchema),
      'missing_env',
    );
    expect(err.message).toContain('CS_DEFINITELY_UNSET_VAR');
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('CS_DEFINITELY_UNSET_VAR');
  });

  it('not_found: missing 文件 → typed error', () => {
    const err = catchStoreError(
      () => loadYamlConfig({ fsFactory }, configPath, testSchema),
      'not_found',
    );
    expect(err.message).toBe(`Config not found: ${configPath}`);
  });

  it('read_failed: 读失败 → typed error + cause', () => {
    fs.writeFileSync(configPath, 'name: chestnut\n');
    fs.chmodSync(configPath, 0o000);
    try {
      const err = catchStoreError(
        () => loadYamlConfig({ fsFactory }, configPath, testSchema),
        'read_failed',
      );
      expect(err.message).toContain('Failed to read config');
      expect(err.cause).toBeDefined();
    } finally {
      fs.chmodSync(configPath, 0o644);
    }
  });

  it('invalid_yaml: YAML 解析失败 → typed error + cause', () => {
    fs.writeFileSync(configPath, '{ invalid yaml: [ }');
    const err = catchStoreError(
      () => loadYamlConfig({ fsFactory }, configPath, testSchema),
      'invalid_yaml',
    );
    expect(err.message).toContain('Invalid YAML in config');
    expect(err.cause).toBeDefined();
  });

  it('invalid_schema: schema 拒绝 → typed error + 原始 schema error 为 cause', () => {
    fs.writeFileSync(configPath, 'name: 123\n');
    const err = catchStoreError(
      () => loadYamlConfig({ fsFactory }, configPath, testSchema),
      'invalid_schema',
    );
    expect(err.message).toContain('Invalid config');
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe('schema: name must be a string');
  });
});

describe('config-store: patchYamlConfig', () => {
  it('patch 保留未知字段、就地修改目标字段（raw read-modify-write）', () => {
    fs.writeFileSync(configPath, 'name: before\nextra:\n  nested: keep-me\n');

    patchYamlConfig({ fsFactory }, configPath, (cfg) => {
      cfg.name = 'after';
    });

    const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(raw).toEqual({ name: 'after', extra: { nested: 'keep-me' } });
  });

  it('expected_object: 拒绝 array 文档', () => {
    fs.writeFileSync(configPath, '- item1\n- item2\n');
    const err = catchStoreError(
      () => patchYamlConfig({ fsFactory }, configPath, () => {}),
      'expected_object',
    );
    expect(err.message).toContain('expected object');
  });

  it('expected_object: 拒绝 scalar 文档', () => {
    fs.writeFileSync(configPath, 'just a scalar\n');
    catchStoreError(
      () => patchYamlConfig({ fsFactory }, configPath, () => {}),
      'expected_object',
    );
  });

  it('patch 路径的 read/YAML 失败进入同一 taxonomy', () => {
    catchStoreError(
      () => patchYamlConfig({ fsFactory }, configPath, () => {}),
      'read_failed',
    );
    fs.writeFileSync(configPath, '{ bad: [ }');
    catchStoreError(
      () => patchYamlConfig({ fsFactory }, configPath, () => {}),
      'invalid_yaml',
    );
  });

  it('patcher 抛出的业务错误原样传播（同一实例、不被包装）', () => {
    fs.writeFileSync(configPath, 'name: chestnut\n');
    const businessError = new Error('business boom');
    let caught: unknown;
    try {
      patchYamlConfig({ fsFactory }, configPath, () => {
        throw businessError;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(businessError);
  });
});

describe('config-store: writeYamlConfig', () => {
  it('write 产出可回读的 YAML（round-trip）', () => {
    writeYamlConfig({ fsFactory }, configPath, { name: 'chestnut', extra: { a: 1 } });
    expect(yaml.load(fs.readFileSync(configPath, 'utf-8'))).toEqual({
      name: 'chestnut',
      extra: { a: 1 },
    });
    expect(loadYamlConfig({ fsFactory }, configPath, testSchema)).toEqual({ name: 'chestnut' });
  });

  it('write 委托 FileSystem atomic writer', () => {
    const nodeFs = new NodeFileSystem({ baseDir: tempDir });
    const spy = vi.spyOn(nodeFs, 'writeAtomicSync');
    writeYamlConfig({ fsFactory: () => nodeFs }, configPath, { name: 'chestnut' });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('config.yaml', expect.any(String));
  });
});

describe('config-store: configExists', () => {
  it('missing/present 双态', () => {
    expect(configExists({ fsFactory }, configPath)).toBe(false);
    writeYamlConfig({ fsFactory }, configPath, { name: 'chestnut' });
    expect(configExists({ fsFactory }, configPath)).toBe(true);
  });
});
