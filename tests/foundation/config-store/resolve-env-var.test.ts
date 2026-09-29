/**
 * Phase 1925 Step B: ConfigStore `${VAR}` 解析注入 seam 测试。
 *
 * LoaderDeps.resolveEnvVar 注入分层解析（如 Credentials owner）；缺省保持
 * process.env 查找；缺席错误文案与 missing_env taxonomy 逐字不变；resolver
 * 自身抛出的业务错误原样传播（不进 missing_env）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

import {
  loadYamlConfig,
  writeYamlConfig,
  ConfigStoreError,
  type ConfigSchema,
} from '../../../src/foundation/config-store/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

interface Cfg { key: string }
const schema: ConfigSchema<Cfg> = {
  parse(data: unknown): Cfg {
    const rec = data as Record<string, unknown>;
    if (typeof rec.key !== 'string') throw new Error('schema: key must be a string');
    return { key: rec.key };
  },
};

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = createTrackedTempDirSync('chestnut-store-resolver-');
  configPath = path.join(tempDir, 'config.yaml');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LoaderDeps.resolveEnvVar 注入', () => {
  it('注入 resolver 优先于 process.env', () => {
    writeYamlConfig({ fsFactory }, configPath, { key: '${MY_VAR}' });
    const loaded = loadYamlConfig(
      { fsFactory, resolveEnvVar: (name) => (name === 'MY_VAR' ? 'injected' : undefined) },
      configPath,
      schema,
    );
    expect(loaded).toEqual({ key: 'injected' });
  });

  it('缺省回退 process.env；缺席错误文案与 missing_env 不变', () => {
    writeYamlConfig({ fsFactory }, configPath, { key: '${DEFINITELY_MISSING_VAR_1925}' });
    try {
      loadYamlConfig({ fsFactory }, configPath, schema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigStoreError);
      expect((err as ConfigStoreError).code).toBe('missing_env');
      expect((err as Error).message).toContain('Environment variable "DEFINITELY_MISSING_VAR_1925" is not set');
    }
  });

  it('resolver 返回 undefined → missing_env（同文案）', () => {
    writeYamlConfig({ fsFactory }, configPath, { key: '${WHATEVER}' });
    try {
      loadYamlConfig({ fsFactory, resolveEnvVar: () => undefined }, configPath, schema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigStoreError);
      expect((err as ConfigStoreError).code).toBe('missing_env');
      expect((err as Error).message).toContain('Environment variable "WHATEVER" is not set');
    }
  });

  it('resolver 抛出的业务错误原样传播（不包装为 missing_env）', () => {
    writeYamlConfig({ fsFactory }, configPath, { key: '${ANY}' });
    class LoudError extends Error {}
    expect(() =>
      loadYamlConfig(
        {
          fsFactory,
          resolveEnvVar: () => { throw new LoudError('loud business failure'); },
        },
        configPath,
        schema,
      ),
    ).toThrowError(LoudError);
  });
});
