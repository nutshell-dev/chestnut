/**
 * Phase 1300 Step B: Assembly RootConfig capability owner 行为测试。
 *
 * 直接验证 Reader/Admin/resolver 契约：schema/default/error 文本与旧 wrapper 一致、
 * 无缓存（每次 load 重新读盘）、方法不依赖 this（可解构）、patch 不改 caller 对象。
 * 核心 load/save/no-cache 一律走真实临时磁盘（CHESTNUT_ROOT + NodeFileSystem），
 * 不 mock 旧函数，避免只验证接线。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { getClawConfigPath } from '../../src/foundation/claw-identity/index.js';
import {
  ClawConfigAlreadyExistsError,
  createRootConfig,
  type RootConfigAdmin,
} from '../../src/assembly/index.js';
import {
  mutateGlobalConfigLocked,
  patchGlobalConfigPrimary,
  saveClawConfig,
} from '../../src/assembly/config/config-load.js';
import type { ClawConfig } from '../../src/assembly/config/compose-config.js';
import type { AtomicWriteResult } from '../../src/foundation/fs/index.js';
import {
  createLLMConfiguration,
  resolveLLMConfig,
  type LLMConfigurationAdmin,
} from '../../src/core/llm-configuration/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tempDir: string;
let admin: RootConfigAdmin;
let llmAdmin: LLMConfigurationAdmin;

function globalConfigPath(): string {
  return path.join(tempDir, '.chestnut', 'config.yaml');
}

function llmConfigPath(): string {
  return path.join(tempDir, '.chestnut', 'llm', 'config.yaml');
}

function writeGlobalConfig(extraLlmYaml = '') {
  const configPath = globalConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `
version: '1'
llm:
  primary:
    preset: anthropic
    label: main
    api_key: \${ROOT_CONFIG_TEST_API_KEY}
    model: claude-test
${extraLlmYaml}
`);
}

function makeClawConfig(name = 'testclaw'): ClawConfig {
  return {
    name,
    tool_profile: 'full',
    max_concurrent_tasks: 3,
    llm: { primary: { provider_id: 'custom:openai', api_format: 'openai', auth_profile: 'api_key', label: 'main', api_key: '${ROOT_CONFIG_TEST_API_KEY}', model: 'gpt-test', base_url: 'https://example.test/v1', temperature: 0.7, timeout_ms: 120000 } },
  };
}

function atomicWriteResults(): AtomicWriteResult[] {
  return [
    { kind: 'durable' },
    { kind: 'committed_platform_limited', error: Object.assign(new Error('unsupported fsync'), { code: 'EINVAL' }) },
    { kind: 'committed_durability_unknown', error: Object.assign(new Error('unknown fsync failure'), { code: 'EIO' }) },
  ];
}

function controlledWriteDeps(write: () => AtomicWriteResult) {
  return {
    fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
      override writeAtomicSync(path: string, content: string): AtomicWriteResult {
        if (path.endsWith('config.yaml')) return write();
        return super.writeAtomicSync(path, content);
      }
    })({ baseDir }),
  };
}

function expectThrowIdentity(fn: () => unknown, expected: unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBe(expected);
  }
}

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-root-config-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  vi.stubEnv('ROOT_CONFIG_TEST_API_KEY', 'sk-test');
  admin = createRootConfig({ fsFactory });
  llmAdmin = createLLMConfiguration({ fsFactory });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('RootConfigReader: isInitialized', () => {
  it('global config 缺失时 false，写入后 true', () => {
    expect(admin.isInitialized()).toBe(false);
    writeGlobalConfig();
    expect(admin.isInitialized()).toBe(true);
  });
});

describe('RootConfigReader/Admin: global load/save', () => {
  it('missing 时 fail-loud，错误文本与旧 wrapper 一致', () => {
    expect(() => admin.loadGlobal()).toThrow('Global config not found.');
  });

  it('schema 与 loadGlobalConfig 缺段均不物化 circuit_breaker', () => {
    writeGlobalConfig();
    const cfg = admin.loadGlobal();
    expect(cfg.llm.primary.model).toBe('claude-test');
    expect(cfg.llm.circuit_breaker).toBeUndefined();
  });

  it('saveGlobal 后可回读，invalid YAML 错误文本与旧 wrapper 一致', () => {
    admin.saveGlobalExclusive({
      version: '1',
      llm: { primary: { preset: 'anthropic', label: 'main', api_key: '${ROOT_CONFIG_TEST_API_KEY}', model: 'claude-save' } },
    });
    expect(admin.loadGlobal().llm.primary.api_key).toBe('sk-test');

    fs.writeFileSync(globalConfigPath(), '{ invalid yaml: [ }');
    expect(() => admin.loadGlobal()).toThrow('Invalid YAML in config');
  });
});

describe('RootConfigReader/Admin: claw load/save', () => {
  it('missing 返回 undefined；saveClaw 后 typed 回读', () => {
    const clawPath = getClawConfigPath('testclaw');
    expect(admin.loadClaw(clawPath)).toBeUndefined();

    admin.saveClaw(clawPath, {
      name: 'testclaw',
      tool_profile: 'full',
      max_concurrent_tasks: 3,
      llm: { primary: { provider_id: 'custom:openai', api_format: 'openai', auth_profile: 'api_key', label: 'main', api_key: '${ROOT_CONFIG_TEST_API_KEY}', model: 'gpt-test', base_url: 'https://example.test/v1', temperature: 0.7, timeout_ms: 120000 } },
    });
    const claw = admin.loadClaw(clawPath);
    expect(claw?.name).toBe('testclaw');
    expect(claw?.llm?.primary?.model).toBe('gpt-test');
    expect(claw?.llm?.primary?.entry_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('claw save 缺 ID 时分配且已有保留，load 只读不写盘', () => {
    const clawPath = getClawConfigPath('entry-id-claw');
    const config = makeClawConfig('entry-id-claw');
    admin.saveClaw(clawPath, config);
    const afterSave = fs.readFileSync(clawPath, 'utf8');
    const first = admin.loadClaw(clawPath);
    const entryId = first?.llm?.primary?.entry_id;
    expect(entryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(config.llm?.primary?.entry_id).toBeUndefined();

    admin.loadClaw(clawPath);
    expect(fs.readFileSync(clawPath, 'utf8')).toBe(afterSave);
    admin.saveClaw(clawPath, {
      ...config,
      llm: { primary: { ...config.llm!.primary!, entry_id: entryId } },
    });
    expect(admin.loadClaw(clawPath)?.llm?.primary?.entry_id).toBe(entryId);

    const legacyBytes = fs.readFileSync(clawPath, 'utf8')
      .split('\n').filter(line => !line.trimStart().startsWith('entry_id:')).join('\n');
    fs.writeFileSync(clawPath, legacyBytes);
    const legacy = admin.loadClaw(clawPath);
    expect(legacy?.llm?.primary?.entry_id).toBeUndefined();
    expect(fs.readFileSync(clawPath, 'utf8')).toBe(legacyBytes);
    admin.saveClaw(clawPath, config);
    const assigned = admin.loadClaw(clawPath)?.llm?.primary?.entry_id;
    expect(assigned).toMatch(/^[0-9a-f-]{36}$/);
    expect(assigned).not.toBe(entryId);
  });
});

describe('Assembly config write results (Phase 2154 Step B3)', () => {
  it('saveClawConfig 与 RootConfigAdmin.saveClaw 原样返回三种 AtomicWriteResult', () => {
    const clawPath = getClawConfigPath('write-result');
    for (const result of atomicWriteResults()) {
      expect(saveClawConfig(controlledWriteDeps(() => result), clawPath, makeClawConfig())).toBe(result);
      expect(createRootConfig(controlledWriteDeps(() => result)).saveClaw(clawPath, makeClawConfig())).toBe(result);
    }
  });

  it('mutateGlobalConfigLocked 与 patchGlobalConfigPrimary 原样返回三种 AtomicWriteResult', async () => {
    writeGlobalConfig();
    admin.loadGlobal();

    for (const result of atomicWriteResults()) {
      const mutated = await mutateGlobalConfigLocked(controlledWriteDeps(() => result), (config) => {
        config.llm.primary.model = 'claude-mutated';
      });
      expect(mutated).toBe(result);

      const patched = await patchGlobalConfigPrimary(controlledWriteDeps(() => result), { model: 'claude-patched' });
      expect(patched).toBe(result);
    }
  });

  it('普通配置写的 rename-before 异常保持 identity', async () => {
    const clawPath = getClawConfigPath('write-throw');
    const clawFailure = new Error('injected claw rename failure');
    expectThrowIdentity(
      () => saveClawConfig(controlledWriteDeps(() => { throw clawFailure; }), clawPath, makeClawConfig()),
      clawFailure,
    );
    expectThrowIdentity(
      () => createRootConfig(controlledWriteDeps(() => { throw clawFailure; })).saveClaw(clawPath, makeClawConfig()),
      clawFailure,
    );

    writeGlobalConfig();
    admin.loadGlobal();
    const globalFailure = new Error('injected global rename failure');
    const throwingDeps = () => controlledWriteDeps(() => { throw globalFailure; });
    await expect(mutateGlobalConfigLocked(throwingDeps(), () => {})).rejects.toBe(globalFailure);
    await expect(patchGlobalConfigPrimary(throwingDeps(), { model: 'claude-patched' })).rejects.toBe(globalFailure);
  });

  it('saveClawExclusive 首次创建仍返回 void，already_exists 保持 typed 异常且不覆盖', () => {
    const clawPath = getClawConfigPath('exclusiveclaw');
    const winner = makeClawConfig('exclusiveclaw');
    expect(admin.saveClawExclusive(clawPath, winner)).toBeUndefined();
    expect(admin.loadClaw(clawPath)?.llm?.primary?.entry_id).toMatch(/^[0-9a-f-]{36}$/);

    expect(() => admin.saveClawExclusive(clawPath, { ...winner, max_concurrent_tasks: 99 }))
      .toThrow(ClawConfigAlreadyExistsError);
    expect(admin.loadClaw(clawPath)?.max_concurrent_tasks).toBe(3);
  });
});

describe('RootConfigAdmin: patchPrimary', () => {
  it('目标字段变化、未知字段保留、caller patch 对象不被修改', async () => {
    writeGlobalConfig(`  fallbacks:\n    - preset: openai\n      label: fallback\n      api_key: \${ROOT_CONFIG_TEST_API_KEY}\n      model: gpt-fb\n`);
    admin.loadGlobal();
    const patch: Readonly<Record<string, unknown>> = Object.freeze({ model: 'claude-new' });
    await llmAdmin.patchPrimary(patch);

    const cfg = admin.loadGlobal();
    expect(cfg.llm.primary.model).toBe('claude-new');
    expect(cfg.llm.primary.api_key).toBe('sk-test');
    expect(cfg.llm.fallbacks).toHaveLength(1);
    expect(patch).toEqual({ model: 'claude-new' });
  });
});

describe('RootConfig: 无缓存语义', () => {
  it('两次 load 之间外部改盘，第二次必须看到新值', () => {
    writeGlobalConfig();
    expect(admin.loadGlobal().llm.primary.model).toBe('claude-test');

    fs.writeFileSync(
      llmConfigPath(),
      fs.readFileSync(llmConfigPath(), 'utf8').replace('claude-test', 'claude-external'),
    );
    expect(admin.loadGlobal().llm.primary.model).toBe('claude-external');
  });
});

describe('RootConfig: 方法绑定（不依赖 this）', () => {
  it('解构方法后直接调用成功', async () => {
    writeGlobalConfig();
    const { isInitialized, loadGlobal, loadClaw } = admin;
  const { patchPrimary } = llmAdmin;
    expect(isInitialized()).toBe(true);
    expect(loadGlobal().llm.primary.model).toBe('claude-test');
    expect(loadClaw(getClawConfigPath('missing'))).toBeUndefined();
    await patchPrimary({ model: 'claude-destructured' });
    expect(loadGlobal().llm.primary.model).toBe('claude-destructured');
  });
});

describe('resolveLLMConfig resolver', () => {
  it('global-only 与 claw override 结果等价旧 build 行为', () => {
    writeGlobalConfig();
    const globalCfg = admin.loadGlobal();

    const globalOnly = resolveLLMConfig(globalCfg);
    expect(globalOnly.primary.input.model).toBe('claude-test');
    expect(globalOnly.legacyCircuitBreaker).toBeUndefined();

    const clawPath = getClawConfigPath('overrideclaw');
    admin.saveClaw(clawPath, {
      name: 'overrideclaw',
      tool_profile: 'full',
      max_concurrent_tasks: 3,
      llm: { primary: { provider_id: 'custom:openai', api_format: 'openai', auth_profile: 'api_key', label: 'main', api_key: '${ROOT_CONFIG_TEST_API_KEY}', model: 'gpt-ovr', base_url: 'https://example.test/v1', temperature: 0.7, timeout_ms: 120000 } },
    });
    const clawCfg = admin.loadClaw(clawPath);
    const withClaw = resolveLLMConfig(globalCfg, clawCfg);
    expect(withClaw.primary.input.model).toBe('gpt-ovr');
    expect(withClaw.primary.entryId).toBe(clawCfg?.llm?.primary?.entry_id);
    expect(withClaw.primary.entryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(withClaw.primary.entryId).not.toBe(globalOnly.primary.entryId);
    // claw 只覆盖 primary，fallback/retry/breaker 仍取 global。
    expect(withClaw.retry).toEqual(globalOnly.retry);
    expect(withClaw.legacyCircuitBreaker).toEqual(globalOnly.legacyCircuitBreaker);
  });
});

/* ---------- Phase 1910 Step D: 初始化独占提交 + 锁内 mutation ---------- */

describe('RootConfigAdmin: saveGlobalExclusive (Phase 1910 Step D)', () => {
  it('首次提交成功；并发 loser typed GlobalConfigAlreadyExistsError 且不覆盖', async () => {
    const { GlobalConfigAlreadyExistsError } = await import('../../src/assembly/index.js');
    admin.saveGlobalExclusive({
      version: '1',
      llm: { primary: { preset: 'anthropic', label: 'main', api_key: '${ROOT_CONFIG_TEST_API_KEY}', model: 'claude-winner' } },
    });

    expect(() => admin.saveGlobalExclusive({
      version: '1',
      llm: { primary: { preset: 'openai', label: 'main', api_key: '${ROOT_CONFIG_TEST_API_KEY}', model: 'gpt-loser' } },
    })).toThrow(GlobalConfigAlreadyExistsError);

    // 先写者内容原样保留
    expect(admin.loadGlobal().llm.primary.api_key).toBe('sk-test');
  });
});

describe('RootConfigAdmin: mutateGlobalLocked (Phase 1910 Step D)', () => {
  it('两个并发 mutation 的字段都落盘（锁内重读，不丢更新）', async () => {
    writeGlobalConfig();
    admin.loadGlobal();
    await Promise.all([
      llmAdmin.mutateGlobalLocked((cfg) => { cfg.llm.primary.model = 'model-a'; }),
      llmAdmin.mutateGlobalLocked((cfg) => { cfg.llm.retry_attempts = 9; }),
    ]);
    const cfg = admin.loadGlobal();
    expect(cfg.llm.primary.model).toBe('model-a');
    expect(cfg.llm.retry_attempts).toBe(9);
    // 锁文件已释放
    expect(fs.existsSync(`${llmConfigPath()}.lock`)).toBe(false);
  });

  it('mutator 业务错误原样传播且不提交', async () => {
    writeGlobalConfig();
    admin.loadGlobal();
    const boom = new Error('business reject');
    await expect(llmAdmin.mutateGlobalLocked(() => { throw boom; })).rejects.toBe(boom);
    expect(admin.loadGlobal().llm.primary.model).toBe('claude-test');
    expect(fs.existsSync(`${llmConfigPath()}.lock`)).toBe(false);
  });

  it('mutateGlobalLocked 与 patchPrimary 互斥：并发不丢更新', async () => {
    writeGlobalConfig();
    admin.loadGlobal();
    await Promise.all([
      llmAdmin.mutateGlobalLocked((cfg) => { cfg.llm.retry_delay_ms = 1234; }),
      llmAdmin.patchPrimary({ model: 'claude-patched' }),
    ]);
    const cfg = admin.loadGlobal();
    expect(cfg.llm.retry_delay_ms).toBe(1234);
    expect(cfg.llm.primary.model).toBe('claude-patched');
    expect(cfg.llm.primary.api_key).toBe('sk-test');
    expect(fs.existsSync(`${llmConfigPath()}.lock`)).toBe(false);
  });
});
