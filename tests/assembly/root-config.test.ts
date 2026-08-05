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
import { getClawConfigPath } from '../../src/core/claw-topology/claw-instance-paths.js';
import {
  createRootConfig,
  resolveLLMConfig,
  type RootConfigAdmin,
} from '../../src/assembly/index.js';
// 兼容 alias identity 断言需引用旧名（同一模块深链，属临时兼容出口）。
import { buildLLMConfig } from '../../src/assembly/config/config-load.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tempDir: string;
let admin: RootConfigAdmin;

function globalConfigPath(): string {
  return path.join(tempDir, '.chestnut', 'config.yaml');
}

function writeGlobalConfig(extraLlmYaml = '') {
  const configPath = globalConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `
version: '1'
llm:
  primary:
    preset: anthropic
    api_key: sk-test
    model: claude-test
${extraLlmYaml}
`);
}

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-root-config-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  admin = createRootConfig({ fsFactory });
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

  it('schema default 与旧 loadGlobalConfig 一致（circuit_breaker 物化默认）', () => {
    writeGlobalConfig();
    const cfg = admin.loadGlobal();
    expect(cfg.llm.primary.model).toBe('claude-test');
    expect(cfg.llm.circuit_breaker).toEqual({
      failure_threshold: 3,
      reset_timeout_ms: 60_000,
    });
  });

  it('saveGlobal 后可回读，invalid YAML 错误文本与旧 wrapper 一致', () => {
    admin.saveGlobal({
      version: '1',
      llm: { primary: { preset: 'anthropic', api_key: 'sk-save', model: 'claude-save' } },
    });
    expect(admin.loadGlobal().llm.primary.api_key).toBe('sk-save');

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
      llm: { primary: { preset: 'openai', api_key: 'sk-claw', model: 'gpt-test', temperature: 0.7, timeout_ms: 120000 } },
    });
    const claw = admin.loadClaw(clawPath);
    expect(claw?.name).toBe('testclaw');
    expect(claw?.llm?.primary?.model).toBe('gpt-test');
  });
});

describe('RootConfigAdmin: patchPrimary', () => {
  it('目标字段变化、未知字段保留、caller patch 对象不被修改', () => {
    writeGlobalConfig(`  fallbacks:\n    - preset: openai\n      api_key: sk-fb\n      model: gpt-fb\n`);
    const patch: Readonly<Record<string, unknown>> = Object.freeze({ model: 'claude-new' });
    admin.patchPrimary(patch);

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
      globalConfigPath(),
      fs.readFileSync(globalConfigPath(), 'utf8').replace('claude-test', 'claude-external'),
    );
    expect(admin.loadGlobal().llm.primary.model).toBe('claude-external');
  });
});

describe('RootConfig: 方法绑定（不依赖 this）', () => {
  it('解构方法后直接调用成功', () => {
    writeGlobalConfig();
    const { isInitialized, loadGlobal, loadClaw, patchPrimary } = admin;
    expect(isInitialized()).toBe(true);
    expect(loadGlobal().llm.primary.model).toBe('claude-test');
    expect(loadClaw(getClawConfigPath('missing'))).toBeUndefined();
    patchPrimary({ model: 'claude-destructured' });
    expect(loadGlobal().llm.primary.model).toBe('claude-destructured');
  });
});

describe('resolveLLMConfig resolver', () => {
  it('global-only 与 claw override 结果等价旧 build 行为', () => {
    writeGlobalConfig();
    const globalCfg = admin.loadGlobal();

    const globalOnly = resolveLLMConfig(globalCfg);
    expect(globalOnly.primary.model).toBe('claude-test');
    expect(globalOnly.circuitBreaker).toEqual({
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
    });

    const clawPath = getClawConfigPath('overrideclaw');
    admin.saveClaw(clawPath, {
      name: 'overrideclaw',
      tool_profile: 'full',
      max_concurrent_tasks: 3,
      llm: { primary: { preset: 'openai', api_key: 'sk-ovr', model: 'gpt-ovr', temperature: 0.7, timeout_ms: 120000 } },
    });
    const clawCfg = admin.loadClaw(clawPath);
    const withClaw = resolveLLMConfig(globalCfg, clawCfg);
    expect(withClaw.primary.model).toBe('gpt-ovr');
    // claw 只覆盖 primary，fallback/retry/breaker 仍取 global。
    expect(withClaw.maxAttempts).toBe(globalOnly.maxAttempts);
    expect(withClaw.circuitBreaker).toEqual(globalOnly.circuitBreaker);
  });

  it('buildLLMConfig 是同一函数的 deprecated alias（无双实现）', () => {
    expect(buildLLMConfig).toBe(resolveLLMConfig);
  });
});
