/**
 * Phase 1910 Step D — initCommand 并发初始化治理（RACE-CONFIG-INIT-LOST-UPDATE）
 *
 * 覆盖：
 * - 双进程 init 交错：winner 提交后 loser 走 already_exists → 保留 winner 配置，
 *   loser 不覆盖、不写 INIT_DONE、不残留 lock；
 * - 事后 pre-check 路径（已初始化直接返回）不回归。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const commandDeps = { fsFactory, rootConfig: createRootConfig({ fsFactory }) };

// ── readline mock ──────────────────────────────────────────────────────────────
const { rlAnswers } = vi.hoisted(() => ({ rlAnswers: { queue: [] as string[] } }));

const mockRl = {
  question: vi.fn((_prompt: string, cb: (a: string) => void) => {
    cb(rlAnswers.queue.shift() ?? '');
  }),
  close: vi.fn(),
  _writeToOutput: undefined as unknown,
};

vi.mock('readline', () => ({
  createInterface: vi.fn(() => mockRl),
}));

// ── llm-connection-check mock ─────────────────────────────────────────────────
const { connMock } = vi.hoisted(() => ({
  connMock: {
    checkLLMConnection: vi.fn(),
    promptReconfigure: vi.fn(),
  },
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  checkLLMConnection: connMock.checkLLMConnection,
  promptReconfigure: connMock.promptReconfigure,
  formatLLMError: vi.fn().mockReturnValue([]),
  LLM_ERROR_LABELS: {},
  LLM_ERROR_HINTS: {},
  classifyLLMError: vi.fn().mockReturnValue('unknown'),
}));

// ── audit log mock ─────────────────────────────────────────────────────────────
const { auditCalls } = vi.hoisted(() => ({ auditCalls: { entries: [] as string[][] } }));
const mockAudit = {
  __brand: 'AuditLog' as const,
  write: vi.fn((...args: string[]) => {
    auditCalls.entries.push(args);
  }),
  preview: vi.fn((s: string) => s),
  message: vi.fn((s: string) => s),
  summary: vi.fn((s: string) => s),
} as unknown as import('../../src/foundation/audit/index.js').AuditLog;

const { initCommand } = await import('../../src/cli/commands/init.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');

let tempDir: string;

function configPath(): string {
  return path.join(tempDir, '.chestnut', 'config.yaml');
}

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-init-race-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
  mockRl.question.mockClear();
  mockRl.close.mockClear();
  rlAnswers.queue = [];
  auditCalls.entries = [];
  connMock.checkLLMConnection.mockReset();
  connMock.promptReconfigure.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('initCommand — 并发初始化（Phase 1910 Step D）', () => {
  it('交错双 init：winner 配置保留，loser already_exists 返回、不覆盖、不写 INIT_DONE', async () => {
    // winner 的 probe 挂起，保证 loser 在 winner 提交后、probe 完成前进入
    let releaseProbe: (v: { ok: true; model: string }) => void = () => {};
    connMock.checkLLMConnection.mockImplementation(
      () => new Promise((resolve) => { releaseProbe = resolve; }),
    );

    rlAnswers.queue = ['1', '1', 'model-winner'];
    const winner = initCommand(commandDeps, true, { audit: mockAudit });
    // 等 winner 完成交互 + 独占提交、进入 probe 等待
    await vi.waitUntil(() => connMock.checkLLMConnection.mock.calls.length > 0);

    rlAnswers.queue = ['1', '1', 'model-loser'];
    await initCommand(commandDeps, true, { audit: mockAudit }); // loser 同步完成

    releaseProbe({ ok: true, model: 'model-winner' });
    await winner;

    // winner 的配置原样保留（loser 未覆盖）
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.model).toBe('model-winner');

    // 恰好一次完整 init（INIT_DONE 只有 winner 写）
    const doneEvents = auditCalls.entries.filter(e => e[0] === 'cli_init_done');
    expect(doneEvents).toHaveLength(1);

    // 无 lock 残留
    expect(fs.existsSync(`${configPath()}.lock`)).toBe(false);
  });

  it('事后重放：已初始化 → 直接返回（pre-check 不回归）', async () => {
    connMock.checkLLMConnection.mockResolvedValue({ ok: true, model: 'model-winner' });
    rlAnswers.queue = ['1', '1', 'model-winner'];
    await initCommand(commandDeps, true, { audit: mockAudit });
    expect(loadGlobalConfig({ fsFactory }).llm.primary.model).toBe('model-winner');

    // 第二次 init：pre-check 命中，不进入交互、不改配置
    mockRl.question.mockClear();
    rlAnswers.queue = [];
    await initCommand(commandDeps, true, { audit: mockAudit });
    expect(mockRl.question).not.toHaveBeenCalled();
    expect(loadGlobalConfig({ fsFactory }).llm.primary.model).toBe('model-winner');
  });
});
