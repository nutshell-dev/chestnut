/**
 * MotionRuntime 单元测试
 *
 * 覆盖场景:
 * - buildSystemPrompt() 注入顺序正确
 * - buildSystemPrompt() 包含 SOUL.md/REVIEW.md 内容
 * - 缺少模板文件时的降级行为
 *
 * phase266 重构：MotionRuntime subclass 消除，改为 ClawRuntime + motion options 构造
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ClawRuntime } from '../../src/core/runtime.js';
import { buildMotionSystemPrompt } from '../../src/core/create-runtime.js';
import type { LLMServiceConfig } from '../../src/foundation/llm/types.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';

// 测试用的 LLM 配置
const mockLLMConfig: LLMServiceConfig = {
  primary: {
    name: 'test',
    apiKey: 'test-key',
    model: 'test-model',
    maxTokens: 100,
    temperature: 0,
  },
  maxAttempts: 1,
  retryDelayMs: 0,
};

async function createTempDir(): Promise<string> {
  // clawDir 必须是 workspace/claws/{name} 结构
  // runtime.ts:125 做 path.resolve(clawDir, '..', '..') 推算 workspaceDir
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-test-'));
  const clawDir = path.join(base, 'claws', 'motion-test');
  await fs.mkdir(clawDir, { recursive: true });
  return clawDir;
}

async function cleanupDir(clawDir: string): Promise<void> {
  // clawDir = base/claws/motion-test，清理 base 根目录
  const base = path.resolve(clawDir, '..', '..');
  await fs.rm(base, { recursive: true, force: true });
}

async function createMotionRuntime(options: { clawId: string; clawDir: string; llmConfig: LLMServiceConfig }) {
  const deps = await makeRuntimeDeps({ clawDir: options.clawDir, clawId: options.clawId, llmConfig: options.llmConfig });
  return new ClawRuntime({
    ...options,
    dependencies: deps,
    systemPromptBuilder: buildMotionSystemPrompt,
    identityToolFilter: (registry) => registry.unregister('send'),
  });
}

describe('MotionRuntime', () => {
  let tempDir: string;
  let runtime: ClawRuntime;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.stop().catch(() => {});
    }
    await cleanupDir(tempDir);
  });

  describe('buildSystemPrompt()', () => {
    it('should include SOUL.md content when present', async () => {
      // Arrange: 创建必要的文件
      await fs.mkdir(path.join(tempDir, 'dialog'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'AGENTS.md'), '## Agent Role\nTest agent');
      await fs.writeFile(path.join(tempDir, 'SOUL.md'), '## Soul\nEfficiency first');
      await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });

      runtime = await createMotionRuntime({
        clawId: 'motion-test',
        clawDir: tempDir,
        llmConfig: mockLLMConfig,
      });

      // Act
      await runtime.initialize();
      const prompt = await (runtime as any).buildSystemPrompt();

      // Assert
      expect(prompt).toContain('## Agent Role');
      expect(prompt).toContain('## Soul');
      expect(prompt).toContain('Efficiency first');
    });

    it('should have correct injection order: AGENTS → SOUL → MEMORY', async () => {
      // Arrange
      await fs.mkdir(path.join(tempDir, 'dialog'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'AGENTS_CONTENT');
      await fs.writeFile(path.join(tempDir, 'SOUL.md'), 'SOUL_CONTENT');
      await fs.writeFile(path.join(tempDir, 'MEMORY.md'), 'MEMORY_CONTENT');
      await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });

      runtime = await createMotionRuntime({
        clawId: 'motion-test',
        clawDir: tempDir,
        llmConfig: mockLLMConfig,
      });

      // Act
      await runtime.initialize();
      const prompt = await (runtime as any).buildSystemPrompt();

      // Assert: 验证顺序
      const agentsIndex = prompt.indexOf('AGENTS_CONTENT');
      const soulIndex = prompt.indexOf('SOUL_CONTENT');
      const memoryIndex = prompt.indexOf('MEMORY_CONTENT');

      expect(agentsIndex).toBeGreaterThanOrEqual(0);
      expect(soulIndex).toBeGreaterThan(agentsIndex);
      expect(memoryIndex).toBeGreaterThan(soulIndex);
    });

    it('should gracefully degrade when SOUL.md is missing', async () => {
      // Arrange: 不创建 SOUL.md
      await fs.mkdir(path.join(tempDir, 'dialog'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'AGENTS_CONTENT');
      await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });

      runtime = await createMotionRuntime({
        clawId: 'motion-test',
        clawDir: tempDir,
        llmConfig: mockLLMConfig,
      });

      // Act & Assert: 不应抛出错误
      await runtime.initialize();
      const prompt = await (runtime as any).buildSystemPrompt();
      expect(prompt).toContain('AGENTS_CONTENT');
      expect(prompt).not.toContain('SOUL_CONTENT');
    });

    it('should gracefully degrade when REVIEW.md is missing', async () => {
      // Arrange: 不创建 REVIEW.md
      await fs.mkdir(path.join(tempDir, 'dialog'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'AGENTS_CONTENT');
      await fs.writeFile(path.join(tempDir, 'SOUL.md'), 'SOUL_CONTENT');
      await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });

      runtime = await createMotionRuntime({
        clawId: 'motion-test',
        clawDir: tempDir,
        llmConfig: mockLLMConfig,
      });

      // Act & Assert
      await runtime.initialize();
      const prompt = await (runtime as any).buildSystemPrompt();
      expect(prompt).toContain('AGENTS_CONTENT');
      expect(prompt).toContain('SOUL_CONTENT');
      expect(prompt).not.toContain('REVIEW_CONTENT');
    });

    it('should gracefully degrade when AGENTS.md is missing', async () => {
      // Arrange: 不创建 AGENTS.md
      await fs.mkdir(path.join(tempDir, 'dialog'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'SOUL.md'), 'SOUL_CONTENT');
      await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });

      runtime = await createMotionRuntime({
        clawId: 'motion-test',
        clawDir: tempDir,
        llmConfig: mockLLMConfig,
      });

      // Act & Assert
      await runtime.initialize();
      const prompt = await (runtime as any).buildSystemPrompt();
      expect(prompt).toContain('SOUL_CONTENT');
      expect(prompt).not.toContain('AGENTS_CONTENT');
    });

    it('should skip empty SOUL.md content', async () => {
      // Arrange: 创建空的 SOUL.md
      await fs.mkdir(path.join(tempDir, 'dialog'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'AGENTS_CONTENT');
      await fs.writeFile(path.join(tempDir, 'SOUL.md'), '   \n   '); // 只有空白字符
      await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });

      runtime = await createMotionRuntime({
        clawId: 'motion-test',
        clawDir: tempDir,
        llmConfig: mockLLMConfig,
      });

      // Act
      await runtime.initialize();
      const prompt = await (runtime as any).buildSystemPrompt();

      // Assert: AGENTS 后面应该直接是 skills/contract（没有 SOUL）
      expect(prompt).toContain('AGENTS_CONTENT');
      // 空白内容被 trim() 后为空，不应加入 sections
    });
  });

  describe('inheritance', () => {
    it('should extend ClawRuntime correctly', async () => {
      // Arrange
      await fs.mkdir(path.join(tempDir, 'dialog'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'Test');
      await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });

      runtime = await createMotionRuntime({
        clawId: 'motion-test',
        clawDir: tempDir,
        llmConfig: mockLLMConfig,
      });

      // Act & Assert
      await runtime.initialize();
      expect(runtime).toBeInstanceOf(ClawRuntime);

      // 验证继承的方法可用
      const status = runtime.getStatus();
      expect(status.clawId).toBe('motion-test');
      expect(status.initialized).toBe(true);
    });
  });

  describe('send tool unregistration', () => {
    it('should not have send tool after initialize', async () => {
      await fs.mkdir(path.join(tempDir, 'dialog'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'AGENTS.md'), 'Test');
      await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });

      runtime = await createMotionRuntime({
        clawId: 'motion-test',
        clawDir: tempDir,
        llmConfig: mockLLMConfig,
      });

      await runtime.initialize();

      const toolNames = (runtime as any).toolRegistry.getAll().map((t: any) => t.name);
      expect(toolNames).not.toContain('send');
    });
  });

});
