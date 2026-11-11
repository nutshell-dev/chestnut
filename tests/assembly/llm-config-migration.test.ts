import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { createRootConfig } from '../../src/assembly/index.js';
import { loadGlobalConfig } from '../../src/assembly/config/config-load.js';
import {
  llmConfigurationSourceDigest,
  readLLMMigrationRecord,
  type SharedLLMInput,
} from '../../src/core/llm-configuration/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { AtomicWriteResult } from '../../src/foundation/fs/index.js';
import {
  cleanupTempDirSync,
  createTrackedTempDirSync,
} from '../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
const deps = { fsFactory };

let projectDir: string;
let homeDir: string;

function rootConfigPath(): string {
  return path.join(projectDir, '.chestnut', 'config.yaml');
}

function targetConfigPath(): string {
  return path.join(projectDir, '.chestnut', 'llm', 'config.yaml');
}

function makeLegacyLLM(
  apiKey = 'sk-legacy',
  model = 'claude-legacy',
): SharedLLMInput {
  return {
    primary: { preset: 'anthropic', api_key: apiKey, model },
    retry_attempts: 2,
  };
}

function writeYaml(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, yaml.dump(value));
}

function readYaml(filePath: string): Record<string, unknown> {
  return yaml.load(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function writeLegacyRoot(llm: SharedLLMInput = makeLegacyLLM()): Record<string, unknown> {
  const root = {
    version: '1',
    default_max_steps: 37,
    tool_timeout_ms: 12_345,
    root_marker: { preserved: true },
    llm,
  };
  writeYaml(rootConfigPath(), root);
  return root;
}

function writeTarget(source: SharedLLMInput, revision = 1): void {
  writeYaml(targetConfigPath(), {
    ...source,
    schema_version: 1,
    revision,
  });
}

function migrationId(source: SharedLLMInput): string {
  return `root-${llmConfigurationSourceDigest(source).slice(0, 24)}`;
}

beforeEach(() => {
  projectDir = createTrackedTempDirSync('chestnut-llm-migration-project-');
  homeDir = createTrackedTempDirSync('chestnut-llm-migration-home-');
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
  vi.stubEnv('CHESTNUT_HOME', homeDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirSync(projectDir);
  cleanupTempDirSync(homeDir);
});

describe('legacy root LLM migration', () => {
  it('自动迁移并记录 sourceDigest，清源后保留 root 的非 llm 字段', () => {
    const legacy = makeLegacyLLM();
    writeLegacyRoot(legacy);

    const loaded = createRootConfig(deps).loadGlobal();

    expect(loaded.llm.primary.model).toBe('claude-legacy');
    expect(readYaml(rootConfigPath())).toEqual({
      version: '1',
      default_max_steps: 37,
      tool_timeout_ms: 12_345,
      root_marker: { preserved: true },
    });
    expect(readYaml(targetConfigPath())).toEqual({
      ...legacy,
      schema_version: 1,
      revision: 1,
    });

    const id = migrationId(legacy);
    const sourceDigest = llmConfigurationSourceDigest(legacy);
    expect(readLLMMigrationRecord(deps, id)).toMatchObject({
      schema_version: 1,
      migration_id: id,
      source_digest: sourceDigest,
      target_digest: sourceDigest,
      target_write: 'durable',
      source_cleanup: 'durable',
    });
  });

  it('raw ${REF} 原样落入目标，仅 resolved 返回值展开', () => {
    const ref = '${PHASE2125_MIGRATION_API_KEY}';
    vi.stubEnv('PHASE2125_MIGRATION_API_KEY', 'sk-resolved-only');
    writeLegacyRoot(makeLegacyLLM(ref));

    const loaded = loadGlobalConfig(deps);

    expect(loaded.llm.primary.api_key).toBe('sk-resolved-only');
    expect(readYaml(targetConfigPath())).toMatchObject({
      primary: { api_key: ref },
    });
    expect(fs.readFileSync(targetConfigPath(), 'utf8')).toContain(ref);
    expect(fs.readFileSync(targetConfigPath(), 'utf8')).not.toContain('sk-resolved-only');
    expect(readYaml(rootConfigPath()).llm).toBeUndefined();
  });

  it('目标损坏时 fail-loud，不回退 root，也不清源或改写目标', () => {
    writeLegacyRoot();
    const corruptTarget = 'schema_version: 1\nrevision: 1\nprimary: [\n';
    fs.mkdirSync(path.dirname(targetConfigPath()), { recursive: true });
    fs.writeFileSync(targetConfigPath(), corruptTarget);
    const rootBefore = fs.readFileSync(rootConfigPath(), 'utf8');

    expect(() => createRootConfig(deps).loadGlobal()).toThrow(
      'LLM migration target is unreadable; source preserved',
    );

    expect(fs.readFileSync(rootConfigPath(), 'utf8')).toBe(rootBefore);
    expect(readYaml(rootConfigPath()).llm).toEqual(makeLegacyLLM());
    expect(fs.readFileSync(targetConfigPath(), 'utf8')).toBe(corruptTarget);
  });

  it('source/target 冲突时 fail-loud，源与目标均原样保留', () => {
    writeLegacyRoot(makeLegacyLLM('sk-source', 'claude-source'));
    writeTarget(makeLegacyLLM('sk-target', 'claude-target'), 7);
    const rootBefore = fs.readFileSync(rootConfigPath(), 'utf8');
    const targetBefore = fs.readFileSync(targetConfigPath(), 'utf8');

    expect(() => createRootConfig(deps).loadGlobal()).toThrow(
      'LLM migration source/target conflict; neither document was cleared or overwritten',
    );

    expect(fs.readFileSync(rootConfigPath(), 'utf8')).toBe(rootBefore);
    expect(fs.readFileSync(targetConfigPath(), 'utf8')).toBe(targetBefore);
    expect(readYaml(targetConfigPath())).toMatchObject({
      revision: 7,
      primary: { api_key: 'sk-target', model: 'claude-target' },
    });
  });

  it('并发管理迁移由 root 锁串行，幂等且只保留一个目标修订', async () => {
    const legacy = makeLegacyLLM();
    writeLegacyRoot(legacy);
    const first = createRootConfig(deps);
    const second = createRootConfig(deps);

    await Promise.all([
      first.migrateLLMConfiguration(),
      second.migrateLLMConfiguration(),
    ]);

    expect(readYaml(rootConfigPath()).llm).toBeUndefined();
    expect(readYaml(targetConfigPath())).toMatchObject({ revision: 1 });
    expect(readLLMMigrationRecord(deps, migrationId(legacy))).toMatchObject({
      source_cleanup: 'durable',
    });
  });

  it('目标耐久性未确认时保留 root.llm，不清理源', () => {
    const legacy = makeLegacyLLM();
    writeLegacyRoot(legacy);
    const uncertainDeps = {
      fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
        override writeAtomicSync(relativePath: string, content: string): AtomicWriteResult {
          if (this.resolve(relativePath).endsWith('.target')) {
            return {
              kind: 'committed_durability_unknown',
              error: Object.assign(new Error('injected fsync uncertainty'), { code: 'EIO' }),
            };
          }
          return super.writeAtomicSync(relativePath, content);
        }
      })({ baseDir }),
    };

    expect(() => loadGlobalConfig(uncertainDeps)).toThrow(
      'LLM migration target write was not confirmed durable; source preserved',
    );
    expect(readYaml(rootConfigPath()).llm).toEqual(legacy);
    expect(readYaml(targetConfigPath())).toMatchObject({ revision: 1 });
  });

  it('清源失败保留磁盘事实并持久化 cleanup_error', () => {
    const legacy = makeLegacyLLM();
    writeLegacyRoot(legacy);
    const failingDeps = {
      fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
        override writeAtomicSync(relativePath: string, content: string): AtomicWriteResult {
          if (this.resolve(relativePath) === rootConfigPath()) throw new Error('injected root cleanup failure');
          return super.writeAtomicSync(relativePath, content);
        }
      })({ baseDir }),
    };

    expect(() => loadGlobalConfig(failingDeps)).toThrow('injected root cleanup failure');
    expect(readYaml(rootConfigPath()).llm).toEqual(legacy);
    expect(readYaml(targetConfigPath())).toMatchObject({ revision: 1 });
    expect(readLLMMigrationRecord(failingDeps, migrationId(legacy))).toMatchObject({
      source_cleanup: 'failed',
      cleanup_error: expect.stringContaining('injected root cleanup failure'),
    });
  });

  it('同内容目标下重复迁移与加载幂等，不重写目标或迁移证据', () => {
    const legacy = makeLegacyLLM();
    writeLegacyRoot(legacy);
    writeTarget(legacy, 4);
    const targetBefore = fs.readFileSync(targetConfigPath(), 'utf8');
    const admin = createRootConfig(deps);

    expect(admin.loadGlobal().llm.primary.model).toBe('claude-legacy');
    const rootAfterFirstLoad = fs.readFileSync(rootConfigPath(), 'utf8');
    const evidenceAfterFirstLoad = readLLMMigrationRecord(deps, migrationId(legacy));
    expect(evidenceAfterFirstLoad).toMatchObject({ source_cleanup: 'durable' });

    expect(admin.loadGlobal().llm.primary.model).toBe('claude-legacy');
    expect(fs.readFileSync(targetConfigPath(), 'utf8')).toBe(targetBefore);
    expect(fs.readFileSync(rootConfigPath(), 'utf8')).toBe(rootAfterFirstLoad);
    expect(readLLMMigrationRecord(deps, migrationId(legacy))).toEqual(evidenceAfterFirstLoad);
    expect(readYaml(targetConfigPath()).revision).toBe(4);
  });
});
