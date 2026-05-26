/**
 * CLI tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDirSync } from '../utils/temp.js';
import {
  toProviderConfig,
  loadGlobalConfig,
  saveGlobalConfig,
  isInitialized,
  clawExists,
  getGlobalConfigPath,
  getClawDir,
} from '../../src/foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../src/assembly/config-defaults.js';
import { listCommand } from '../../src/cli/commands/claw.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('CLI Config', () => {
  let originalRoot: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalRoot = process.env.CLAWFORUM_ROOT;
    tempDir = await createTempDir();
    process.env.CLAWFORUM_ROOT = tempDir;
  });

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env.CLAWFORUM_ROOT;
    else process.env.CLAWFORUM_ROOT = originalRoot;
    cleanupTempDirSync(tempDir);
  });

  describe('toProviderConfig', () => {
    // Phase 20: preset field and apiFormat
    it('should set apiFormat=openai when preset is openai', () => {
      const result = toProviderConfig({
        preset: 'openai',
        api_key: 'sk-test',
        model: 'gpt-4o',
        max_tokens: 4096,
        temperature: 0.7,
        timeout_ms: 60000,
      });
      expect(result.apiFormat).toBe('openai');
    });

    it('should use label as name when provided', () => {
      const result = toProviderConfig({
        preset: 'openai',
        label: 'My OpenAI',
        api_key: 'sk-test',
        model: 'gpt-4o',
        max_tokens: 4096,
        temperature: 0.7,
        timeout_ms: 60000,
      });
      expect(result.name).toBe('My OpenAI');
    });

    it('should map snake_case to camelCase', () => {
      const input = {
        preset: 'anthropic',
        api_key: 'test-key',
        base_url: 'https://api.anthropic.com',
        model: 'claude-3-5-haiku',
        max_tokens: 4096,
        temperature: 0.7,
        timeout_ms: 60000,
      };

      const result = toProviderConfig(input);

      expect(result.name).toBe('anthropic');
      expect(result.apiKey).toBe('test-key');
      expect(result.baseUrl).toBe('https://api.anthropic.com');
      expect(result.model).toBe('claude-3-5-haiku');
      expect(result.maxTokens).toBe(4096);
      expect(result.temperature).toBe(0.7);
      expect(result.timeoutMs).toBe(60000);
    });

    it('should handle optional base_url', () => {
      const input = {
        preset: 'anthropic',
        api_key: 'test-key',
        model: 'claude-3-5-haiku',
        max_tokens: 4096,
        temperature: 0.7,
        timeout_ms: 60000,
      };

      const result = toProviderConfig(input);

      expect(result.baseUrl).toBe('https://api.anthropic.com');
    });
  });

  describe('loadGlobalConfig', () => {
    it('should throw error when config not found', () => {
      expect(() => loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS)).toThrow('Run "clawforum init" first');
    });

    it('should throw error for invalid yaml', () => {
      const configPath = getGlobalConfigPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, 'invalid: yaml: content: [}');

      expect(() => loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS)).toThrow();
    });

    it('should load valid config', () => {
      const config = {
        version: '1',
        llm: {
          primary: {
            preset: 'anthropic',
            api_key: 'test-key',
            model: 'claude-3-5-haiku',
            max_tokens: 4096,
            temperature: 0.7,
            timeout_ms: 60000,
          },
          retry_attempts: 3,
          retry_delay_ms: 1000,
        },
      };
      saveGlobalConfig({ fsFactory }, config);

      const loaded = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);

      expect(loaded.version).toBe('1');
      expect(loaded.llm.primary.api_key).toBe('test-key');
    });
  });

  describe('isInitialized', () => {
    it('should return false when not initialized', () => {
      expect(isInitialized({ fsFactory })).toBe(false);
    });

    it('should return true when initialized', () => {
      const configPath = getGlobalConfigPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, 'version: 1\n');

      expect(isInitialized({ fsFactory })).toBe(true);
    });
  });

  describe('clawExists', () => {
    it('should return false for non-existent claw', () => {
      expect(clawExists({ fsFactory }, 'nonexistent')).toBe(false);
    });

    it('should return true for existing claw', () => {
      const clawDir = getClawDir('test-claw');
      fs.mkdirSync(clawDir, { recursive: true });
      fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: test-claw\n');

      expect(clawExists({ fsFactory }, 'test-claw')).toBe(true);
    });
  });

  describe('listCommand', () => {
    it('should list all claws with their status', async () => {
      // 创建全局配置
      const config = {
        version: '1',
        llm: {
          primary: {
            preset: 'anthropic',
            api_key: 'test-key',
            model: 'claude-3-5-haiku',
            max_tokens: 4096,
            temperature: 0.7,
            timeout_ms: 60000,
          },
          retry_attempts: 3,
          retry_delay_ms: 1000,
        },
      };
      saveGlobalConfig({ fsFactory }, config);

      // 创建两个测试 claw
      const clawDir1 = getClawDir('claw-alpha');
      const clawDir2 = getClawDir('claw-beta');
      fs.mkdirSync(clawDir1, { recursive: true });
      fs.mkdirSync(clawDir2, { recursive: true });
      fs.writeFileSync(path.join(clawDir1, 'config.yaml'), 'name: claw-alpha\n');
      fs.writeFileSync(path.join(clawDir2, 'config.yaml'), 'name: claw-beta\n');

      // 执行 list 命令（不抛出错误即成功）
      await expect(listCommand({ fsFactory })).resolves.not.toThrow();
    });

    it('should handle empty claws directory', async () => {
      // 创建全局配置但不创建任何 claw
      const config = {
        version: '1',
        llm: {
          primary: {
            preset: 'anthropic',
            api_key: 'test-key',
            model: 'claude-3-5-haiku',
            max_tokens: 4096,
            temperature: 0.7,
            timeout_ms: 60000,
          },
          retry_attempts: 3,
          retry_delay_ms: 1000,
        },
      };
      saveGlobalConfig({ fsFactory }, config);

      // 执行 list 命令（应该正常返回，提示没有 claws，不抛出错误）
      await expect(listCommand({ fsFactory })).resolves.toBeUndefined();
    });

    it('should auto-create claws directory if not exists', async () => {
      // 创建全局配置
      const config = {
        version: '1',
        llm: {
          primary: {
            preset: 'anthropic',
            api_key: 'test-key',
            model: 'claude-3-5-haiku',
            max_tokens: 4096,
            temperature: 0.7,
            timeout_ms: 60000,
          },
          retry_attempts: 3,
          retry_delay_ms: 1000,
        },
      };
      saveGlobalConfig({ fsFactory }, config);

      // 确保 claws 目录不存在
      const clawsDir = path.join(path.dirname(getGlobalConfigPath()), 'claws');
      if (fs.existsSync(clawsDir)) {
        fs.rmSync(clawsDir, { recursive: true });
      }

      // 执行 list 命令应该自动创建目录
      await expect(listCommand({ fsFactory })).resolves.toBeUndefined();
      expect(fs.existsSync(clawsDir)).toBe(true);
    });
  });

  // Phase 20: expandEnvVars — exercised through loadGlobalConfig()
  describe('loadGlobalConfig - expandEnvVars', () => {
    it('should expand ${VAR} syntax in api_key', () => {
      process.env.TEST_CLAW_API_KEY_EXPAND = 'resolved-secret-value';
      const configPath = getGlobalConfigPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      // Single-quoted string: no JS template interpolation, ${} written literally
      const rawYaml = 'version: "1"\nllm:\n  primary:\n    name: anthropic\n    api_key: ${TEST_CLAW_API_KEY_EXPAND}\n    model: claude-3-5-haiku\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n';
      fs.writeFileSync(configPath, rawYaml);

      const loaded = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
      expect(loaded.llm.primary.api_key).toBe('resolved-secret-value');

      delete process.env.TEST_CLAW_API_KEY_EXPAND;
    });

    it('should throw when referenced env var is not set', () => {
      delete process.env.MISSING_CLAW_TEST_VAR_XYZ;
      const configPath = getGlobalConfigPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const rawYaml = 'version: "1"\nllm:\n  primary:\n    name: anthropic\n    api_key: ${MISSING_CLAW_TEST_VAR_XYZ}\n    model: test\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n';
      fs.writeFileSync(configPath, rawYaml);

      expect(() => loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS)).toThrow(/MISSING_CLAW_TEST_VAR_XYZ/);
    });
  });
});
