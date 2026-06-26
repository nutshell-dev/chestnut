/**
 * Phase 1459 — ExecContext ISP α-1 decomposition (P3 alpha minimum scope)
 *
 * Coverage:
 * - ExecContextImpl 满足 5 子接口（type-level）
 * - 每子接口可单独作类型 narrow
 * - 反向 1: 删 ClawIdentity 字段 → tsc fail
 * - 反向 2: 改字段 type → tsc fail
 * - 反向 3: cloneExecContext partial override 兼容（runtime 行为 0 变）
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  ExecContext,
  ClawIdentity,
  ToolPermissions,
  ExecutionInfra,
  ExecutionControl,
  ExecutionAudit,
} from '../../../src/foundation/tools/types.js';
import { ExecContextImpl, cloneExecContext } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

describe('phase 1459 ExecContext ISP α-1 decomposition', () => {
  async function makeCtx(): Promise<ExecContextImpl> {
    const tempDir = path.join(tmpdir(), `ec-isp-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const mockFs = new NodeFileSystem({ baseDir: tempDir });
    return new ExecContextImpl({
      clawId: 'test-claw' as ExecContext['clawId'],
      clawDir: tempDir as ExecContext['clawDir'],
      clawsDir: path.join(tempDir, 'claws'),
      syncDir: tempDir,
      profile: 'full',
      allowedGroups: new Set(['audit']),
      callerLabel: 'test',
      fs: mockFs,
      maxSteps: 10,
    });
  }

  it('(1) ExecContextImpl is assignable to ClawIdentity', async () => {
    const ctx = await makeCtx();
    const id: ClawIdentity = ctx;
    expect(id.clawId).toBe('test-claw');
  });

  it('(2) ExecContextImpl is assignable to ToolPermissions', async () => {
    const ctx = await makeCtx();
    const perm: ToolPermissions = ctx;
    expect(perm.profile).toBe('full');
    expect(perm.allowedGroups instanceof Set).toBe(true);
    expect(perm.callerLabel).toBe('test');
  });

  it('(3) ExecContextImpl is assignable to ExecutionInfra', async () => {
    const ctx = await makeCtx();
    const infra: ExecutionInfra = ctx;
    expect(infra.fs).toBeDefined();
  });

  it('(4) ExecContextImpl is assignable to ExecutionControl', async () => {
    const ctx = await makeCtx();
    const ctrl: ExecutionControl = ctx;
    expect(ctrl.maxSteps).toBe(10);
    expect(ctrl.stopRequested).toBe(false);
    expect(ctrl.getElapsedMs()).toBeGreaterThanOrEqual(0);
  });

  it('(5) ExecContextImpl is assignable to ExecutionAudit', async () => {
    const ctx = await makeCtx();
    const audit: ExecutionAudit = ctx;
    expect(audit.readFileState instanceof Map).toBe(true);
  });

  it('(6) tool execute can declare narrow sub-interface dependency', async () => {
    const ctx = await makeCtx();
    function auditOnlyTool(ctx: ClawIdentity & ExecutionAudit): string {
      ctx.readFileState.set('/tmp/x', { hash: 'h', timestamp: 0, isFullRead: true });
      return ctx.clawId;
    }
    expect(auditOnlyTool(ctx)).toBe('test-claw');
  });

  it('(7) cloneExecContext partial override still works (regression / 反向 3)', async () => {
    const ctx = await makeCtx();
    const clone = cloneExecContext(ctx, { stopRequested: false });
    expect(clone.stopRequested).toBe(false);
    expect(clone.clawId).toBe('test-claw');
    clone.requestStop();
    expect(ctx.stopRequested).toBe(true);
  });

  it('(8) ExecContext extends 5 sub-interfaces (structural verify)', async () => {
    const ctx = await makeCtx();
    const c: ExecContext = ctx;
    const subs: [ClawIdentity, ToolPermissions, ExecutionInfra, ExecutionControl, ExecutionAudit] = [
      c, c, c, c, c,
    ];
    expect(subs.length).toBe(5);
  });
});
