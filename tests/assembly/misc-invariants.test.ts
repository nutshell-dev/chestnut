/**
 * misc invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - tool-context-resolution.test.ts
 *  - llm-audit-sink.test.ts
 *  - motion-callerType.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import type { ToolPermissions } from '../../src/foundation/tools/types.js';
import { createLLMAuditSink } from '../../src/assembly/llm-audit-sink.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { createNotifyClawTool } from '../../src/core/claw-topology/tools/notify-claw.js';
import { formatClawStatusHint } from '../../src/cli/commands/claw-shared.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../helpers/audit.js';
import { routeNotifyClaw } from '../../src/core/claw-topology/index.js';

describe('tool-context-resolution', () => {
  /**
   * @module Tests.Assembly
   * ToolContext resolution at assembly time (phase 1337 sub-2 / phase 807)
   */

  describe('ToolContext assembly resolution', () => {

    it('ExecContextImpl constructor does NOT accept callerLabel', () => {
      const ctx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: '/tmp/test',
        syncDir: '/tmp/test/sync',
        profile: 'subagent',
        fs: {} as import('../../src/foundation/fs/types.js').FileSystem,
        maxSteps: 10,
      });
      expect(ctx.clawId).toBe('test-claw');
      // @ts-expect-error callerLabel was removed in phase 807
      expect(ctx.callerLabel).toBeUndefined();
    });

    it('ToolPermissions no longer contains callerLabel', () => {
      const perm: ToolPermissions = { profile: 'full' };
      expect(perm).not.toHaveProperty('callerLabel');
    });
  });
});

describe('llm-audit-sink', () => {
  /**
   * LLM audit sink tests
   *
   * Tests: createLLMAuditSink — audit.write throw 时的 console.error fallback + isolation 保
   * 历史：phase604 NEW
   */

  describe('createLLMAuditSink critical fallback (phase 604 / B.llm-audit-sink-recursion-boundary)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('audit.write throw → console.error [LLM AUDIT SINK CRITICAL] + sink 不抛（isolation 保）', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const audit: AuditLog = {
        write: vi.fn(() => { throw new Error('audit fs full'); }),
        preview: vi.fn((s: string) => s),
        message: vi.fn((s: string) => s),
        summary: vi.fn((s: string) => s),
      };
      const sink = createLLMAuditSink(audit);

      // sink emit 不抛（isolation 保）
      expect(() => sink.emit({
        type: 'provider_attempt_failed',
        provider: 'openai',
        attempt: 1,
        error: 'mock',
      } as any)).not.toThrow();

      // console.error 真触发 + 含 [LLM AUDIT SINK CRITICAL] prefix
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\[LLM AUDIT SINK CRITICAL\]/),
      );

      consoleSpy.mockRestore();
    });

    it('audit.write success → console.error 0 调（无 fallback noise）', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const audit: AuditLog = {
        write: vi.fn(),   // 成功,
        preview: vi.fn((s: string) => s),
        message: vi.fn((s: string) => s),
        summary: vi.fn((s: string) => s),
      };
      const sink = createLLMAuditSink(audit);

      sink.emit({
        type: 'provider_attempt_failed',
        provider: 'openai',
        attempt: 1,
        error: 'mock',
      } as any);

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });
  });
});

describe('motion-callerType', () => {
  describe('motion callerType assemble fix (phase 1160 P0-1 / phase 807 DI)', () => {
    let tempDir: string;
    let chestnutDir: string;
    let audit: ReturnType<typeof makeAudit>;

    beforeEach(() => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      tempDir = path.join(os.tmpdir(), `motion-callerType-${randomUUID()}`);
      chestnutDir = path.join(tempDir, '.chestnut');
      fsNative.mkdirSync(chestnutDir, { recursive: true });
      audit = makeAudit();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fsNative.rmSync(tempDir, { recursive: true, force: true });
    });

    function makeDeps(fs: NodeFileSystem) {
      return {
        isClawAlive: () => true,
        formatClawStatusHint,
        clawExists: () => true,
        hasActiveContract: () => false,
        defaultSource: 'motion',
        fs,
        notifyClaw: (targetClawId: string, message: any) =>
          routeNotifyClaw(fs, chestnutDir, 'motion', targetClawId, message, audit.audit),
        audit: audit.audit,
      };
    }

    // 反向 1: authorized DI flag=true → notify-claw guard passes (end-to-end)
    it('反向 1: authorized=true → notify-claw guard passes', async () => {
      const fs = new NodeFileSystem({ baseDir: chestnutDir });
      await fs.ensureDir('claws/target-claw');

      const tool = createNotifyClawTool({ ...makeDeps(fs), authorized: true });

      const result = await tool.execute(
        { to: 'target-claw', body: 'hello' },
        { clawId: 'motion' } as any,
      );

      expect(result.success).toBe(true);
      const sentRows = audit.events.filter(
        r => r[0] === 'notify_claw_sent',
      );
      expect(sentRows.length).toBe(1);
    });

    // 反向 2: restricted instance authorized=false → notify-claw guard rejects (regression)
    it('反向 2: restricted instance authorized=false → notify-claw guard rejects', async () => {
      const fs = new NodeFileSystem({ baseDir: chestnutDir });
      await fs.ensureDir('claws/target-claw');

      const mainTool = createNotifyClawTool({ ...makeDeps(fs), authorized: true });
      const restrictedTool = { ...mainTool, authorized: false };

      const result = await restrictedTool.execute(
        { to: 'target-claw', body: 'hello' },
        { clawId: 'motion' } as any,
      );

      expect(result.success).toBe(false);
      expect(result.content).toBe('notify_claw is motion-only');
    });
  });
});
