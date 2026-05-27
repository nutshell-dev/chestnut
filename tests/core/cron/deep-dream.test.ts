/**
 * deep-dream 测试
 *
 * 覆盖路径：
 * - 目录不存在 / 无 session 文件 → 提前返回
 * - 正常处理：调用 LLM 两次，生成 inbox 消息，更新 state
 * - Fix 1 回归：Call 2 不传 system prompt
 * - Fix 2 回归：空会话时 state 仍落盘
 * - 已处理文件不重复处理
 * - Call 2 失败时降级处理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { runDeepDream } from '../../../src/core/memory/deep-dream.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

// ─── LLMOrchestrator mock ──────────────────────────────────────────

const mockLlmCall = vi.fn();

const mockLlmService = {
  call: mockLlmCall,
  stream: vi.fn(),
  healthCheck: vi.fn(),
  getProviderInfo: vi.fn(),
  close: vi.fn(),
};

// ─── 工具函数 ─────────────────────────────────────────────────

function makeTextResponse(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

function makeSessionJson(messages: Array<{ role: string; content: string }>) {
  return JSON.stringify({ messages });
}

// LLMOrchestrator 是 mock，config 字段无实际意义
const fakeLlmConfig: LLMOrchestratorConfig = {
  primary: { name: 'test', apiKey: 'sk-test', model: 'claude-test' } as any,
};

const mockAudit = { write: vi.fn() };
const clawFsFactory = (clawDir: string): FileSystem => new NodeFileSystem({ baseDir: clawDir });

// ─── 测试 ─────────────────────────────────────────────────────

describe('runDeepDream', () => {
  let clawforumDir: string;

  beforeEach(async () => {
    clawforumDir = await createTempDir();
    mockLlmCall.mockReset();
    mockLlmCall.mockResolvedValue(makeTextResponse('dream output'));
  });

  afterEach(async () => {
    await cleanupTempDir(clawforumDir);
    vi.clearAllMocks();
    vi.restoreAllMocks(); // phase 880: defense-in-depth, restore prototype-level spies if inline mockRestore skipped due to exception
  });

  // ── 无 claws 目录 ───────────────────────────────────────────

  it('claws 目录不存在时直接返回，不调用 LLM', async () => {
    await expect(runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory })).resolves.toBeUndefined();
    expect(mockLlmCall).not.toHaveBeenCalled();
  });

  // ── 正常处理流程 ────────────────────────────────────────────

  describe('单个 claw 处理', () => {
    let clawDir: string;
    let archiveDir: string;

    beforeEach(async () => {
      clawDir = path.join(clawforumDir, 'claws', 'test-claw');
      archiveDir = path.join(clawDir, 'dialog', 'archive');
      await fs.mkdir(archiveDir, { recursive: true });
      await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
    });

    // ── Dream State I/O 错误处理（phase 561）────────────────────

    describe('Dream State I/O 错误处理（phase 561）', () => {
      it('loadDreamState parse 错时 audit DEEP_DREAM_ERROR step=load_state 并返空（A.dream-state-io-silent）', async () => {
        // 写损坏的 state 文件
        await fs.writeFile(path.join(clawDir, '.deep-dream-state.json'), 'corrupted{', 'utf-8');
        const session = makeSessionJson([
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ]);
        const filename = `1000000000000_abcd1234.json`;
        await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');

        mockLlmCall
          .mockResolvedValueOnce(makeTextResponse('dream'))
          .mockResolvedValueOnce(makeTextResponse('compressed'));

        await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

        // audit 记录了 load_state 错误
        expect(mockAudit.write).toHaveBeenCalledWith(
          'cron_deep_dream_error',
          'step=load_state',
          expect.stringMatching(/^clawId=/),
          expect.stringMatching(/^reason=.*corrupted/),
        );

        // state 被重置后流程继续，archive 被处理
        const statePath = path.join(clawDir, '.deep-dream-state.json');
        const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
        expect(state.processedArchives).toContain(filename);
      });

      it('loadDreamState FileNotFoundError 时 silent 返空（首启良性）', async () => {
        const session = makeSessionJson([
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ]);
        const filename = `1000000000001_abcd1234.json`;
        await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');

        mockLlmCall
          .mockResolvedValueOnce(makeTextResponse('dream'))
          .mockResolvedValueOnce(makeTextResponse('compressed'));

        await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

        // audit 没有记录 load_state 错误
        expect(mockAudit.write).not.toHaveBeenCalledWith(
          'cron_deep_dream_error',
          'step=load_state',
          expect.anything(),
          expect.anything(),
        );

        // 流程正常完成
        const statePath = path.join(clawDir, '.deep-dream-state.json');
        const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
        expect(state.processedArchives).toContain(filename);
      });

      it('saveDreamState writeAtomicSync 失败时 audit step=save_state 但不 re-throw（F36）', async () => {
        const session = makeSessionJson([
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ]);
        const filename = `1000000000002_abcd1234.json`;
        await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');

        mockLlmCall
          .mockResolvedValueOnce(makeTextResponse('dream'))
          .mockResolvedValueOnce(makeTextResponse('compressed'));

        const originalWriteAtomicSync = NodeFileSystem.prototype.writeAtomicSync;
        const writeSpy = vi.spyOn(NodeFileSystem.prototype, 'writeAtomicSync').mockImplementation(function (this: NodeFileSystem, p: string, content: string) {
          if (p === '.deep-dream-state.json') {
            throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
          }
          return originalWriteAtomicSync.call(this, p, content);
        });

        await expect(runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory })).resolves.toBeUndefined();

        // audit 记录了 save_state 错误
        expect(mockAudit.write).toHaveBeenCalledWith(
          'cron_deep_dream_error',
          'step=save_state',
          expect.stringMatching(/^clawId=/),
          expect.stringMatching(/^reason=.*EIO/),
        );

        writeSpy.mockRestore();
      });
    });

    // ── sessionFile retry-storm 防御（phase 597）────────────────

    describe('sessionFile retry-storm 防御（phase 597）', () => {
      it('sessionFile JSON.parse 失败 → audit step=read_session + 强制 push processedArchives 防 retry-storm（A.dream-session-retry-storm phase 597）', async () => {
        // setup: 写 1 个损坏 archive 文件
        const filename = `1000000000003_corrupt.json`;
        await fs.writeFile(path.join(archiveDir, filename), 'invalid{', 'utf-8');

        await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

        // audit 记录 step=read_session
        expect(mockAudit.write).toHaveBeenCalledWith(
          'cron_deep_dream_error',
          'step=read_session',
          expect.stringMatching(/^clawId=/),
          expect.stringMatching(`^file=${filename}$`),
          expect.stringMatching(/^reason=/),
        );

        // state 含损坏 archive（永标记跳过 / 防 retry-storm）
        const statePath = path.join(clawDir, '.deep-dream-state.json');
        const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
        expect(state.processedArchives).toContain(filename);
      });

      it('current.json 损坏不 push processedArchives（保留当日重试可能）', async () => {
        // setup: current.json 损坏 / 0 archive
        const currentPath = path.join(clawDir, 'dialog', 'current.json');
        await fs.mkdir(path.dirname(currentPath), { recursive: true });
        await fs.writeFile(currentPath, 'invalid{', 'utf-8');

        await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

        // DialogStore 内部处理 corrupted（不抛错给 deep-dream）→ deep-dream 跳过 current.json
        // 验证：DialogStore 发出内部 corrupted / cold_start audit（不依赖 deep-dream 的 step=read_session）
        const calls = mockAudit.write.mock.calls as string[][];
        const hasDialogAudit = calls.some(call =>
          call.some(arg => typeof arg === 'string' && (
            arg.startsWith('dialog_') || arg === 'session_corrupted'
          ))
        );
        expect(hasDialogAudit).toBe(true);

        // state 不应含 'current.json' in processedArchives（current.json 不入永标记列表）
        const statePath = path.join(clawDir, '.deep-dream-state.json');
        if (fsSync.existsSync(statePath)) {
          const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
          expect(state.processedArchives ?? []).not.toContain('current.json');
        }
      });
    });

    it('无 session 文件时不调用 LLM', async () => {
      await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });
      expect(mockLlmCall).not.toHaveBeenCalled();
    });

    it('处理单个 archive 文件：LLM 调用 2 次，生成 inbox 消息，更新 state', async () => {
      const session = makeSessionJson([
        { role: 'user', content: 'help me with the task' },
        { role: 'assistant', content: 'sure, let me help' },
      ]);
      const filename = `1000000000000_abcd1234.json`;
      await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');

      mockLlmCall
        .mockResolvedValueOnce(makeTextResponse('dream insight content'))
        .mockResolvedValueOnce(makeTextResponse('compressed summary'));

      await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

      // LLM 调用了两次（Call 1 梦境 + Call 2 压缩）
      expect(mockLlmCall).toHaveBeenCalledTimes(2);

      // state 已更新
      const statePath = path.join(clawDir, '.deep-dream-state.json');
      expect(fsSync.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      expect(state.processedArchives).toContain(filename);

      // inbox 消息已写入
      const inboxDir = path.join(clawDir, 'inbox', 'pending');
      const files = fsSync.readdirSync(inboxDir);
      const hasDeepDream = files.some(f => fsSync.readFileSync(path.join(inboxDir, f), 'utf8').includes('type: deep_dream'));
      expect(hasDeepDream).toBe(true);
    });

    // ── Fix 1 回归：Call 2 不传 system prompt ──────────────────

    it('Fix 1 回归：Call 1 携带 system prompt，Call 2 不携带', async () => {
      const session = makeSessionJson([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ]);
      await fs.writeFile(path.join(archiveDir, `1000000000001_abcd1234.json`), session, 'utf-8');

      mockLlmCall
        .mockResolvedValueOnce(makeTextResponse('dream'))
        .mockResolvedValueOnce(makeTextResponse('compressed'));

      await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

      expect(mockLlmCall).toHaveBeenCalledTimes(2);
      const call1Args = mockLlmCall.mock.calls[0][0] as Record<string, unknown>;
      const call2Args = mockLlmCall.mock.calls[1][0] as Record<string, unknown>;

      expect(call1Args.system).toBeDefined();     // Call 1 有 system prompt
      expect(call2Args.system).toBeUndefined();   // Call 2 无 system prompt（压缩任务）
    });

    // ── Fix 2 回归：空会话时 state 仍落盘 ──────────────────────

    it('Fix 2 回归：空会话 state 仍落盘，且不写 inbox 消息', async () => {
      const emptySession = JSON.stringify({ messages: [] });
      const filename = `1000000000002_abcd1234.json`;
      await fs.writeFile(path.join(archiveDir, filename), emptySession, 'utf-8');

      await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

      // 空会话无内容，不调用 LLM
      expect(mockLlmCall).not.toHaveBeenCalled();

      // state 必须落盘（Fix 2）
      const statePath = path.join(clawDir, '.deep-dream-state.json');
      expect(fsSync.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      expect(state.processedArchives).toContain(filename);

      // 无 inbox 消息
      const inboxDir = path.join(clawDir, 'inbox', 'pending');
      const files = fsSync.readdirSync(inboxDir);
      const deepDreamFiles = files.filter(f => fsSync.readFileSync(path.join(inboxDir, f), 'utf8').includes('type: deep_dream'));
      expect(deepDreamFiles).toHaveLength(0);
    });

    it('仅含 thinking/tool_use 块的会话视为空会话', async () => {
      const session = JSON.stringify({
        messages: [
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal thought' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read', input: {} }] },
        ],
      });
      const filename = `1000000000003_abcd1234.json`;
      await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');

      await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

      expect(mockLlmCall).not.toHaveBeenCalled();

      // state 落盘
      const statePath = path.join(clawDir, '.deep-dream-state.json');
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      expect(state.processedArchives).toContain(filename);
    });

    // ── 已处理文件不重复 ────────────────────────────────────────

    it('已在 state 中的 archive 不重复处理', async () => {
      const session = makeSessionJson([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);
      const filename = `1000000000004_abcd1234.json`;
      await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');

      // 预置 state
      const statePath = path.join(clawDir, '.deep-dream-state.json');
      await fs.writeFile(statePath, JSON.stringify({
        processedArchives: [filename],
        currentSessionDreamedDate: '',
      }), 'utf-8');

      await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

      expect(mockLlmCall).not.toHaveBeenCalled();
    });

    // ── Call 2 失败降级 ─────────────────────────────────────────

    it('Call 2 失败时降级，流程继续完成', async () => {
      const session = makeSessionJson([
        { role: 'user', content: 'task description' },
        { role: 'assistant', content: 'task completed' },
      ]);
      const filename = `1000000000005_abcd1234.json`;
      await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');

      mockLlmCall
        .mockResolvedValueOnce(makeTextResponse('dream insight'))
        .mockRejectedValueOnce(new Error('LLM timeout'));

      // 不抛出异常
      await expect(runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory })).resolves.toBeUndefined();

      // state 已更新，inbox 消息已写入（dreamOutput 仍可用）
      const statePath = path.join(clawDir, '.deep-dream-state.json');
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      expect(state.processedArchives).toContain(filename);

      const inboxDir = path.join(clawDir, 'inbox', 'pending');
      const files = fsSync.readdirSync(inboxDir);
      const hasDeepDream = files.some(f => fsSync.readFileSync(path.join(inboxDir, f), 'utf8').includes('type: deep_dream'));
      expect(hasDeepDream).toBe(true);
    });

    // ── current.json 处理 ───────────────────────────────────────

    it('当日未处理的 current.json 被处理，更新 currentSessionDreamedDate', async () => {
      const currentPath = path.join(clawDir, 'dialog', 'current.json');
      await fs.mkdir(path.dirname(currentPath), { recursive: true });
      const session = makeSessionJson([
        { role: 'user', content: 'current task' },
        { role: 'assistant', content: 'in progress' },
      ]);
      await fs.writeFile(currentPath, session, 'utf-8');

      mockLlmCall
        .mockResolvedValueOnce(makeTextResponse('dream'))
        .mockResolvedValueOnce(makeTextResponse('compressed'));

      await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

      expect(mockLlmCall).toHaveBeenCalledTimes(2);

      const statePath = path.join(clawDir, '.deep-dream-state.json');
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      const today = new Date().toLocaleDateString('sv');
      expect(state.currentSessionDreamedDate).toBe(today);
    });

    it('当日已处理的 current.json 不重复处理', async () => {
      const currentPath = path.join(clawDir, 'dialog', 'current.json');
      await fs.mkdir(path.dirname(currentPath), { recursive: true });
      await fs.writeFile(currentPath, makeSessionJson([
        { role: 'user', content: 'current' },
        { role: 'assistant', content: 'done' },
      ]), 'utf-8');

      const today = new Date().toLocaleDateString('sv');
      const statePath = path.join(clawDir, '.deep-dream-state.json');
      await fs.writeFile(statePath, JSON.stringify({
        processedArchives: [],
        currentSessionDreamedDate: today,
      }), 'utf-8');

      await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

      expect(mockLlmCall).not.toHaveBeenCalled();
    });

  it('传入 motionFs 时 disk snapshot 后 emit DREAM_OUTPUT_PERSISTED 含 dreamId + path + bytes', async () => {
    const motionDir = path.join(clawforumDir, 'motion');
    await fs.mkdir(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    const session = makeSessionJson([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    const filename = `1000000000000_abcd1234.json`;
    await fs.writeFile(path.join(archiveDir, filename), session, 'utf-8');

    mockLlmCall
      .mockResolvedValueOnce(makeTextResponse('dream'))
      .mockResolvedValueOnce(makeTextResponse('compressed'));

    const motionFs = new NodeFileSystem({ baseDir: motionDir });
    await runDeepDream({
      clawforumDir,
      llmConfig: fakeLlmConfig,
      llmService: mockLlmService as any,
      fs: new NodeFileSystem({ baseDir: clawforumDir }),
      motionFs,
      audit: mockAudit,
      clawFsFactory,
    });

    const persistedCall = mockAudit.write.mock.calls.find((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED
    );
    expect(persistedCall).toBeTruthy();
    expect(persistedCall![1]).toMatch(/^dreamId=/);
    expect(persistedCall![2]).toMatch(/^path=memory\/dream-outputs\/.*\.txt$/);
    expect(persistedCall![3]).toMatch(/^bytes=\d+$/);

    // 反向：文件实际落盘
    const outputFiles = fsSync.readdirSync(path.join(motionDir, 'memory', 'dream-outputs'));
    expect(outputFiles.length).toBe(1);
    expect(outputFiles[0]).toMatch(/\.txt$/);
  });
  });

  // ── 多 claw 隔离 ────────────────────────────────────────────

  it('第一个 claw Call 1 失败，第二个 claw 仍正常处理', async () => {
    const makeClawDir = async (clawId: string) => {
      const clawDir = path.join(clawforumDir, 'claws', clawId);
      await fs.mkdir(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
      await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
      return clawDir;
    };

    const clawDir1 = await makeClawDir('claw-fail');
    const clawDir2 = await makeClawDir('claw-ok');

    const session = makeSessionJson([
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'done' },
    ]);
    await fs.writeFile(path.join(clawDir1, 'dialog', 'archive', `1000000000001_fail0000.json`), session, 'utf-8');
    await fs.writeFile(path.join(clawDir2, 'dialog', 'archive', `1000000000002_ok000000.json`), session, 'utf-8');

    // 第一次 Call 1 失败，后续调用正常
    mockLlmCall
      .mockRejectedValueOnce(new Error('claw-fail error'))
      .mockResolvedValue(makeTextResponse('ok dream'));

    await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

    // claw-ok 的 inbox 应有消息
    const inboxFiles = fsSync.readdirSync(path.join(clawDir2, 'inbox', 'pending'));
    const hasDeepDream = inboxFiles.some(f => fsSync.readFileSync(path.join(clawDir2, 'inbox', 'pending', f), 'utf8').includes('type: deep_dream'));
    expect(hasDeepDream).toBe(true);
  });

  // ── 元压缩触发 ──────────────────────────────────────────────

  it('元压缩：compressions 超过 maxCompressionTokens 时触发第 3 次 LLM 调用', async () => {
    const clawDir = path.join(clawforumDir, 'claws', 'claw-meta');
    const archiveDir = path.join(clawDir, 'dialog', 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });

    // 两个 session 文件，第一个产生超长压缩（超过 maxCompressionTokens=100 的阈值）
    const session = makeSessionJson([
      { role: 'user', content: 'task details' },
      { role: 'assistant', content: 'completed the work' },
    ]);
    await fs.writeFile(path.join(archiveDir, `1000000000010_meta0001.json`), session, 'utf-8');
    await fs.writeFile(path.join(archiveDir, `1000000000020_meta0002.json`), session, 'utf-8');

    // Call 1（file1）→ dream, Call 2（file1）→ 超长压缩（> 100*4 = 400 chars）
    // Call 1（file2）→ dream, Call 2（file2）→ compression
    // 元压缩在 Call 1 file2 前触发 → 额外一次调用
    const longCompression = 'x'.repeat(500); // 500 chars → ~125 tokens > maxCompressionTokens=100
    mockLlmCall
      .mockResolvedValueOnce(makeTextResponse('dream 1'))           // Call 1 file1
      .mockResolvedValueOnce(makeTextResponse(longCompression))     // Call 2 file1（超长）
      .mockResolvedValueOnce(makeTextResponse('meta compressed'))   // 元压缩
      .mockResolvedValueOnce(makeTextResponse('dream 2'))           // Call 1 file2
      .mockResolvedValueOnce(makeTextResponse('compression 2'));    // Call 2 file2

    await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, maxCompressionTokens: 100, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

    // 5 次 LLM 调用：Call1+Call2 for file1, 元压缩, Call1+Call2 for file2
    expect(mockLlmCall).toHaveBeenCalledTimes(5);
  });

  // ── 时间戳升序处理 ──────────────────────────────────────────

  it('archive 文件按时间戳升序处理（旧文件的压缩传给新文件）', async () => {
    const clawDir = path.join(clawforumDir, 'claws', 'claw-order');
    const archiveDir = path.join(clawDir, 'dialog', 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });

    const session = makeSessionJson([
      { role: 'user', content: 'work' },
      { role: 'assistant', content: 'done' },
    ]);
    // 时间戳：新文件 ts=2000，旧文件 ts=1000
    await fs.writeFile(path.join(archiveDir, `2000000000000_new00000.json`), session, 'utf-8');
    await fs.writeFile(path.join(archiveDir, `1000000000000_old00000.json`), session, 'utf-8');

    const callOrder: string[] = [];
    mockLlmCall.mockImplementation(async (opts: { messages: Array<{ content: string }> }) => {
      // 从 user message content 判断当前处理的是哪个文件
      const content = opts.messages[0]?.content ?? '';
      callOrder.push(typeof content === 'string' ? content.slice(0, 30) : '');
      return makeTextResponse('response');
    });

    await runDeepDream({ clawforumDir, llmConfig: fakeLlmConfig, llmService: mockLlmService as any, fs: new NodeFileSystem({ baseDir: clawforumDir }), audit: mockAudit, clawFsFactory });

    // 4 次调用（两文件各 Call1+Call2）
    expect(mockLlmCall).toHaveBeenCalledTimes(4);

    // 第 2 次 Call 1（call index 2）的 userMsg 应包含第 1 次 Call 2 产生的压缩
    // 即：第 3 次调用（index=2）的 messages[0].content 应包含压缩内容
    const call3Args = mockLlmCall.mock.calls[2][0] as { messages: Array<{ content: string }> };
    const call3Content = call3Args.messages[0]?.content ?? '';
    // 第 1 个文件处理后，compressions 有内容，第 2 个文件的 buildDreamInput 会包含"前序会话压缩摘要"
    expect(typeof call3Content === 'string' ? call3Content : '').toContain('前序会话');
  });

});
