/**
 * @module tests/core/contract/verification-force-accept-inbox
 * Phase 1405 Fix 1: writeForceAcceptInbox helper 写 claw inbox 反馈
 *
 * Phase 1399 force-accept path 漏写 claw inbox → submit_subtask async 模式 claw 永远等不到 verdict.
 * 本测试核 writeForceAcceptInbox 正确写 verification_result inbox + extraFields.force_accepted='true'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeForceAcceptInbox } from '../../../src/core/contract/verification-notify.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { notifyClaw } from '../../../src/foundation/messaging/index.js';
import * as verificationNotifyMod from '../../../src/core/contract/verification-notify.js';  // phase 263: hoist

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
      title: 'Test', goal: 'Test',
      subtasks: [{ id: 'st1', description: 'ST1' }],
    })),
    getProgress: vi.fn(async () => ({ contract_id: 'c1', status: 'running', subtasks: {} })),
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

describe('phase 1405 Fix 1: writeForceAcceptInbox', () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1405-fa-inbox-'));
    originalEnv = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes an inbox file with verdict=passed + force_accepted=true extraField', () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'test-claw');
    const inboxPending = path.join(clawDir, 'inbox', 'pending');
    fs.mkdirSync(inboxPending, { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(clawDir, 'test-claw', nodeFs, chestnutRoot);

    writeForceAcceptInbox(ctx, 'c1' as any, 'st1' as any, false, 3, 'bad output');

    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(inboxPending, files[0]), 'utf8');
    expect(content).toContain('verdict: "passed"');
    expect(content).toMatch(/force_accepted:\s*true/);
    expect(content).toMatch(/retry_count:\s*3/);
    expect(content).toContain('force-accepted after 3 attempts');
    expect(content).toContain('last_failure: bad output');
  });

  it('emits "All subtasks complete!" when allCompleted=true', () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'test-claw');
    const inboxPending = path.join(clawDir, 'inbox', 'pending');
    fs.mkdirSync(inboxPending, { recursive: true });

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const chestnutRoot = path.join(tempDir, '.chestnut');
    const ctx = makeMinimalCtx(clawDir, 'test-claw', nodeFs, chestnutRoot);

    writeForceAcceptInbox(ctx, 'c1' as any, 'st1' as any, true, 2, undefined);

    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(inboxPending, files[0]), 'utf8');
    expect(content).toContain('All subtasks complete!');
    expect(content).not.toContain('last_failure');
  });

  it('reverse: helper exported from verification-notify barrel', async () => {
    expect(typeof verificationNotifyMod.writeForceAcceptInbox).toBe('function');
  });
});
