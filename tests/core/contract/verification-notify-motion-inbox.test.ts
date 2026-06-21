import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeVerificationInbox, writeVerificationError } from '../../../src/core/contract/verification-notify.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { notifyClaw } from '../../../src/foundation/messaging/index.js';
import { vi } from 'vitest';

function makeMinimalCtx(clawDir: string, clawId: string, nodeFs: NodeFileSystem, chestnutRoot: string): VerificationContext {
  const audit = { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any;
  return {
    clawDir: clawDir as any,
    clawId: clawId as any,
    audit,
    fs: nodeFs as any,
    notifyClaw: (targetClawId, message) => notifyClaw(nodeFs, chestnutRoot, 'motion', targetClawId, message, audit),
    contractDir: vi.fn(async (id: string) => path.join(clawDir, 'contract', 'active', id)),
    loadContractYaml: vi.fn(async () => ({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 'st1', description: 'ST1' }],
    })),
    getProgress: vi.fn(async () => ({
      contract_id: 'c1',
      status: 'running',
      subtasks: {},
    })),
    saveProgress: vi.fn(async () => {}),
    checkAllSubtasksCompleted: vi.fn(async () => false),
    moveContractToArchive: vi.fn(async () => {}),
    emitContractCompleted: vi.fn(async () => {}),
    onNotify: () => {},
    runScriptVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
    runLLMVerification: vi.fn(async () => ({ passed: true, feedback: '' })),
    withProgressLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    toolRegistry: createToolRegistry(),
    runVerifierWithCancel: vi.fn(async () => ({ passed: true, feedback: '' })),
  };
}

describe('phase 1388 Bug B: verification-notify Motion 端写正确 motion/inbox/pending', () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1388-bug-b-'));
    originalEnv = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('Motion 路径 writeVerificationInbox 写到 .chestnut/motion/inbox/pending', () => {
    const motionDir = path.join(tempDir, '.chestnut', 'motion');
    fs.mkdirSync(path.join(motionDir, 'inbox', 'pending'), { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(motionDir, 'motion', nodeFs, chestnutRoot);

    writeVerificationInbox(ctx, 'c1', 'st1', 'passed', false);

    // 正确路径有文件
    const inboxPending = path.join(tempDir, '.chestnut', 'motion', 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);

    // 错位路径不存在
    const wrongPath = path.join(tempDir, 'motion', 'inbox', 'pending');
    expect(fs.existsSync(wrongPath)).toBe(false);
  });

  it('Motion 路径 writeVerificationError 写到 .chestnut/motion/inbox/pending', async () => {
    const motionDir = path.join(tempDir, '.chestnut', 'motion');
    fs.mkdirSync(path.join(motionDir, 'inbox', 'pending'), { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: motionDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(motionDir, 'motion', nodeFs, chestnutRoot);
    (ctx.getProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      contract_id: 'c1',
      status: 'running',
      subtasks: {
        st1: { status: 'in_progress', retry_count: 0 },
      },
    });

    await writeVerificationError(ctx, 'c1', 'st1', new Error('test'));

    const inboxPending = path.join(tempDir, '.chestnut', 'motion', 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);

    const wrongPath = path.join(tempDir, 'motion', 'inbox', 'pending');
    expect(fs.existsSync(wrongPath)).toBe(false);
  });

  it('普通 claw 路径 writeVerificationInbox 写到 .chestnut/claws/<id>/inbox/pending (regression-guard)', () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'test-claw');
    fs.mkdirSync(path.join(clawDir, 'inbox', 'pending'), { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(clawDir, 'test-claw', nodeFs, chestnutRoot);

    writeVerificationInbox(ctx, 'c1', 'st1', 'passed', false);

    const inboxPending = path.join(tempDir, '.chestnut', 'claws', 'test-claw', 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);
  });
});
