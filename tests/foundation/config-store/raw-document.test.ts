/**
 * Phase 2104 Step B: ConfigStore 原始 YAML 值读取契约。
 *
 * 原始值保留 YAML 解析结果，但不展开环境引用、不运行 schema、不写盘；
 * 读取失败沿用 load 的 not_found/read_failed/invalid_yaml 分型与 cause。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  readYamlDocument,
  writeYamlConfig,
  withYamlConfigLock,
  ConfigStoreError,
  isConfigStoreError,
} from '../../../src/foundation/config-store/index.js';
import type { ConfigStoreErrorCode } from '../../../src/foundation/config-store/errors.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = createTrackedTempDirSync('chestnut-store-raw-');
  configPath = path.join(tempDir, 'config.yaml');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

describe('config-store: readYamlDocument', () => {
  it('保留未知字段、嵌套结构与已设置/未设置引用，且不调用 resolver', () => {
    vi.stubEnv('PHASE2104_SET_REF', 'must-not-be-expanded');
    fs.writeFileSync(configPath, [
      'known: value',
      'unknown:',
      '  enabled: true',
      '  count: 3',
      '  nullable: null',
      'refs:',
      '  set: ${PHASE2104_SET_REF}',
      '  unset: ${PHASE2104_UNSET_REF}',
      '  nested:',
      '    - ${PHASE2104_SET_REF}',
      '',
    ].join('\n'));
    const resolveEnvVar = vi.fn(() => { throw new Error('resolver must not run'); });
    const deps = { fsFactory, resolveEnvVar };

    expect(readYamlDocument(deps, configPath)).toEqual({
      known: 'value',
      unknown: { enabled: true, count: 3, nullable: null },
      refs: {
        set: '${PHASE2104_SET_REF}',
        unset: '${PHASE2104_UNSET_REF}',
        nested: ['${PHASE2104_SET_REF}'],
      },
    });
    expect(resolveEnvVar).not.toHaveBeenCalled();
  });

  it('返回空文档、标量与数组的原始 YAML 解析值', () => {
    const cases: Array<[string, unknown]> = [
      ['', undefined],
      ['null\n', null],
      ['true\n', true],
      ['42\n', 42],
      ['plain scalar\n', 'plain scalar'],
      ['- one\n- 2\n- false\n', ['one', 2, false]],
    ];

    for (const [content, expected] of cases) {
      fs.writeFileSync(configPath, content);
      expect(readYamlDocument({ fsFactory }, configPath)).toEqual(expected);
    }
  });

  it('只读成功路径不改变文件字节，也不调用写原语', () => {
    const original = 'name: ${PHASE2104_UNSET_REF}\nunknown: keep\n';
    fs.writeFileSync(configPath, original);
    const before = fs.readFileSync(configPath);
    const nodeFs = new NodeFileSystem({ baseDir: tempDir });
    const atomicWrite = vi.spyOn(nodeFs, 'writeAtomicSync');
    const exclusiveWrite = vi.spyOn(nodeFs, 'writeExclusiveSync');

    expect(readYamlDocument({ fsFactory: () => nodeFs }, configPath)).toEqual({
      name: '${PHASE2104_UNSET_REF}',
      unknown: 'keep',
    });
    expect(fs.readFileSync(configPath)).toEqual(before);
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(exclusiveWrite).not.toHaveBeenCalled();
  });

  it('缺文件返回 not_found，且不创建目录或文件', () => {
    const missingPath = path.join(tempDir, 'missing', 'config.yaml');

    const err = catchStoreError(
      () => readYamlDocument({ fsFactory }, missingPath),
      'not_found',
    );

    expect(err.message).toBe(`Config not found: ${missingPath}`);
    expect(fs.existsSync(path.dirname(missingPath))).toBe(false);
    expect(fs.existsSync(missingPath)).toBe(false);
  });

  it('readSync 失败返回 read_failed 并保留 cause 身份', () => {
    fs.writeFileSync(configPath, 'name: chestnut\n');
    const cause = new Error('injected read failure');
    const nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.spyOn(nodeFs, 'readSync').mockImplementation(() => { throw cause; });

    const err = catchStoreError(
      () => readYamlDocument({ fsFactory: () => nodeFs }, configPath),
      'read_failed',
    );

    expect(err.cause).toBe(cause);
  });

  it('非法 YAML 返回 invalid_yaml 并保留解析异常，不混入 schema 分型', () => {
    fs.writeFileSync(configPath, '{ invalid yaml: [ }');

    const err = catchStoreError(
      () => readYamlDocument({ fsFactory }, configPath),
      'invalid_yaml',
    );

    expect(err.message).toContain('Invalid YAML in config');
    expect(err.cause).toBeDefined();
  });

  it('原始读取→锁内变更→写回不会物化环境引用', async () => {
    const placeholder = '${PHASE2104_TEST_SECRET}';
    const resolvedSecret = 'phase2104-not-a-real-secret';
    fs.writeFileSync(configPath, `credentials:\n  token: ${placeholder}\nunknown: keep\n`);
    const resolveEnvVar = vi.fn((name: string) =>
      name === 'PHASE2104_TEST_SECRET' ? resolvedSecret : undefined);
    const deps = { fsFactory, resolveEnvVar };
    const document = readYamlDocument(deps, configPath);
    expect(document).toEqual({
      credentials: { token: placeholder },
      unknown: 'keep',
    });
    const draft = document as { credentials: { token: string }; unknown: string };

    await withYamlConfigLock({ fsFactory }, configPath, () => {
      draft.credentials.token = '${PHASE2104_NEXT_SECRET}';
      writeYamlConfig({ fsFactory }, configPath, draft);
    });

    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('${PHASE2104_NEXT_SECRET}');
    expect(content).not.toContain(resolvedSecret);
    expect(readYamlDocument({ fsFactory }, configPath)).toEqual({
      credentials: { token: '${PHASE2104_NEXT_SECRET}' },
      unknown: 'keep',
    });
    expect(resolveEnvVar).not.toHaveBeenCalled();
  });
});
