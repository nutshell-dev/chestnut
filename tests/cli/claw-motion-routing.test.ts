/**
 * phase 1986 Step H：motion CLI 路由矩阵（资源类 verb）。
 *
 * 真实产品 handler + 真实临时工作区（NodeFileSystem）；mock 只在
 * PM / stream reader / assembly context 边界。核心 oracle = 文件落在
 * 哪个真实目录，而不是 mock 调用次数。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import * as fssync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { sendCommand } from '../../src/cli/commands/claw-send.js';
import { outboxCommand } from '../../src/cli/commands/claw-outbox.js';
import { outboxSkipCommand } from '../../src/cli/commands/claw-outbox-skip.js';
import { psCommand } from '../../src/cli/commands/claw-ps.js';
import { readCommand } from '../../src/cli/commands/claw-read.js';
import { lsCommand } from '../../src/cli/commands/claw-ls.js';
import { importCommand } from '../../src/cli/commands/claw-import.js';
import { clawStatusCommand } from '../../src/cli/commands/claw-status.js';
import { streamCommand } from '../../src/cli/commands/claw-stream.js';
import { createStreamReader } from '../../src/foundation/stream/index.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/index.js';
import {
  createContractActionContext,
  createMotionContractActionContext,
} from '../../src/assembly/index.js';
import type { MigratedExecTaskInfo, TaskReadError } from '../../src/core/async-task-system/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

// ── 边界 mock：stream reader（长驻 tail 不进真实循环）─────────────────────────
const streamMocks = vi.hoisted(() => ({
  reader: { start: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/foundation/stream/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/stream/index.js')>()),
  createStreamReader: vi.fn(() => streamMocks.reader),
  findRecentTurnStartOffset: vi.fn(() => 0),
}));

// ── 边界 mock：PM（只读 liveness；不 spawn 真实 daemon）────────────────────────
vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>()),
  createProcessManagerForCLI: vi.fn(() => ({
    isAlive: vi.fn(() => false),
    liveness: vi.fn(() => ({ kind: 'absent', reason: 'missing_active' })),
  })),
}));

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>()),
  isAlive: vi.fn(() => false),
  isPidArgvMatching: vi.fn(() => false),
}));

// ── 边界 mock：Assembly context 工厂（wrap 真实实现以断言选择与 dispose）────────
const assemblyMocks = vi.hoisted(() => ({ disposeSpy: vi.fn() }));

vi.mock('../../src/assembly/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/index.js')>();
  return {
    ...actual,
    createContractActionContext: vi.fn(actual.createContractActionContext),
    createMotionContractActionContext: vi.fn(async (...args: unknown[]) => {
      const ctx = await (actual.createMotionContractActionContext as (...a: unknown[]) => Promise<{
        dispose: () => void;
      }>)(...args);
      return {
        ...ctx,
        dispose: () => {
          assemblyMocks.disposeSpy();
          ctx.dispose();
        },
      };
    }),
  };
});

describe('claw motion routing (phase 1986 Step H)', () => {
  let workspaceRoot: string;
  let chestnutRoot: string;
  let motionDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let fsInstanceFor: (dir: string) => NodeFileSystem | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let fsFactorySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workspaceRoot = await createTrackedTempDir('claw-motion-routing-1986-');
    chestnutRoot = path.join(workspaceRoot, '.chestnut');
    motionDir = path.join(chestnutRoot, 'motion');
    await fs.mkdir(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    await fs.mkdir(path.join(motionDir, 'inbox', 'done'), { recursive: true });
    await fs.mkdir(path.join(motionDir, 'outbox', 'pending'), { recursive: true });
    await fs.mkdir(path.join(motionDir, 'outbox', 'done'), { recursive: true });
    await fs.mkdir(path.join(motionDir, 'clawspace'), { recursive: true });
    await fs.mkdir(path.join(motionDir, 'tasks', 'queues', 'pending'), { recursive: true });
    await fs.mkdir(path.join(chestnutRoot, 'claws', 'alice'), { recursive: true });
    await fs.writeFile(path.join(chestnutRoot, 'claws', 'alice', 'config.yaml'), 'name: alice\n');
    await fs.writeFile(path.join(chestnutRoot, 'config.yaml'), 'llm:\n  primary: {}\n');
    vi.stubEnv('CHESTNUT_ROOT', workspaceRoot);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // streamCommand 注册 SIGINT/SIGTERM 监听——测试进程不真正接管信号
    vi.spyOn(process, 'on').mockImplementation(() => process);
    const fsInstances = new Map<string, NodeFileSystem>();
    fsFactorySpy = vi.fn((dir: string) => {
      let inst = fsInstances.get(dir);
      if (!inst) {
        inst = new NodeFileSystem({ baseDir: dir });
        fsInstances.set(dir, inst);
      }
      return inst;
    });
    fsInstanceFor = (dir: string) => fsInstances.get(dir);
    vi.mocked(createStreamReader).mockClear();
    streamMocks.reader.start.mockClear();
    assemblyMocks.disposeSpy.mockClear();
    vi.mocked(createContractActionContext).mockClear();
    vi.mocked(createMotionContractActionContext).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await cleanupTempDir(workspaceRoot);
  });

  function deps() {
    return {
      fsFactory: fsFactorySpy as unknown as (dir: string) => NodeFileSystem,
      rootConfig: {
        loadGlobal: vi.fn(() => ({ viewport: {} }) as never),
        loadClaw: vi.fn((configPath: string) =>
          existsSync(configPath) ? ({} as never) : undefined),
      },
    };
  }

  it('send → 只写 <root>/motion/inbox/pending；不产生 claws/motion', async () => {
    await sendCommand(deps(), 'motion', 'hello world');

    const pending = path.join(motionDir, 'inbox', 'pending');
    const files = fssync.readdirSync(pending).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const content = fssync.readFileSync(path.join(pending, files[0]), 'utf8');
    expect(content).toContain('hello world');
    expect(existsSync(path.join(chestnutRoot, 'claws', 'motion'))).toBe(false);
  });

  it('outbox → drain motion outbox pending → done', async () => {
    await fs.writeFile(path.join(motionDir, 'outbox', 'pending', 'm1.md'), 'motion outbox body');

    await outboxCommand({ fsFactory: fsFactorySpy as never }, 'motion', { limit: 1 });

    const out = consoleLogSpy.mock.calls.flat().join('\n');
    expect(out).toContain('motion outbox body');
    expect(fssync.readdirSync(path.join(motionDir, 'outbox', 'pending')).filter((f) => f.endsWith('.md'))).toHaveLength(0);
    expect(fssync.readdirSync(path.join(motionDir, 'outbox', 'done')).filter((f) => f.endsWith('.md'))).toHaveLength(1);
  });

  it('outbox-skip → skipped 1 message(s)，pending 清空', async () => {
    await fs.writeFile(path.join(motionDir, 'outbox', 'pending', 'm1.md'), 'skip me');

    await outboxSkipCommand({ fsFactory: fsFactorySpy as never }, 'motion', { limit: 1 });

    const out = consoleLogSpy.mock.calls.flat().join('\n');
    expect(out).toContain('skipped 1 message(s)');
    expect(fssync.readdirSync(path.join(motionDir, 'outbox', 'pending')).filter((f) => f.endsWith('.md'))).toHaveLength(0);
  });

  it('ps → listMigratedExecTasks 恰以 <root>/motion 调用', async () => {
    const listSpy = vi.fn((): { tasks: MigratedExecTaskInfo[]; errors: TaskReadError[] } => ({ tasks: [], errors: [] }));

    await psCommand({ listMigratedExecTasks: listSpy }, 'motion', []);

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith(motionDir);
    expect(consoleLogSpy.mock.calls.flat().join('\n')).toContain('No background exec tasks running.');
  });

  it('read → 读 <root>/motion/clawspace/notes.md', async () => {
    await fs.writeFile(path.join(motionDir, 'clawspace', 'notes.md'), 'motion notes content\n');

    await readCommand(deps(), 'motion', 'notes.md');

    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('motion notes content');
  });

  it('ls → 列出 <root>/motion/clawspace 内容', async () => {
    await fs.writeFile(path.join(motionDir, 'clawspace', 'notes.md'), 'x\n');

    await lsCommand(deps(), 'motion', undefined, {});

    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('notes.md');
  });

  it('import → 落 <root>/motion/clawspace；不产生 claws/motion', async () => {
    const src = path.join(workspaceRoot, 'src.txt');
    await fs.writeFile(src, 'imported body\n');

    await importCommand(deps(), src, 'motion');

    const dest = path.join(motionDir, 'clawspace', 'src.txt');
    expect(existsSync(dest)).toBe(true);
    expect(fssync.readFileSync(dest, 'utf8')).toBe('imported body\n');
    expect(existsSync(path.join(chestnutRoot, 'claws', 'motion'))).toBe(false);
  });

  it('status --json → motion Assembly context 工厂恰 1 次、regular 0 次；clawDir=<root>/motion；dispose 恰 1 次', async () => {
    await clawStatusCommand(deps(), 'motion', { json: true });

    expect(vi.mocked(createMotionContractActionContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createContractActionContext)).not.toHaveBeenCalled();
    expect(assemblyMocks.disposeSpy).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(consoleLogSpy.mock.calls.map((c) => String(c[0])).join(''));
    expect(parsed.claw).toBe('motion');
    expect(parsed.clawDir).toBe(motionDir);
  });

  it('stream → fs root=<root>/motion、reader 文件 stream.jsonl；不读 claws/motion', async () => {
    await streamCommand(deps(), 'motion', { startMode: { kind: 'now' } });

    expect(fsFactorySpy).toHaveBeenCalledWith(motionDir);
    expect(fsFactorySpy).not.toHaveBeenCalledWith(path.join(chestnutRoot, 'claws', 'motion'));
    expect(vi.mocked(createStreamReader)).toHaveBeenCalledTimes(1);
    const [readerFs, readerFile] = vi.mocked(createStreamReader).mock.calls[0];
    expect(readerFs).toBe(fsInstanceFor(motionDir));
    expect(readerFile).toBe('stream.jsonl');
    expect(streamMocks.reader.start).toHaveBeenCalledTimes(1);
  });
});
