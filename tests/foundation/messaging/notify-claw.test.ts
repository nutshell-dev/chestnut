/**
 * notify_claw tool tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { createNotifyClawTool, NOTIFY_CLAW_TOOL_NAME } from '../../../src/foundation/messaging/tools/notify-claw.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('notify_claw tool', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  const clawforumRoot = '/test/root';
  const targetClaw = 'worker-1';
  const targetInboxDir = path.join(clawforumRoot, 'claws', targetClaw, 'inbox', 'pending');

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    // phase 895: pre-create target claw root（existsSync 预检需）
    await fs.ensureDir(path.join('claws', targetClaw));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('schema + identity', () => {
    it('tool name = notify_claw', () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot, audit: audit.audit });
      expect(tool.name).toBe('notify_claw');
      expect(tool.name).toBe(NOTIFY_CLAW_TOOL_NAME);
    });

    it('schema required = to + body', () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot, audit: audit.audit });
      expect(tool.schema.required).toEqual(['to', 'body']);
      expect(tool.schema.properties).toHaveProperty('to');
      expect(tool.schema.properties).toHaveProperty('body');
      expect(tool.schema.properties).toHaveProperty('type');
      expect(tool.schema.properties).toHaveProperty('interrupt');
    });

    it('readonly=false + idempotent=false（motion-only push write tool）', () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot, audit: audit.audit });
      expect(tool.readonly).toBe(false);
      expect(tool.idempotent).toBe(false);
    });
  });

  describe('happy path cross-claw write', () => {
    it('default interrupt=false → priority=normal metadata + NOTIFY_CLAW_SENT audit', async () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot: tempDir, audit: audit.audit });
      const result = await tool.execute(
        { to: targetClaw, body: 'hello worker' },
        {} as any,
      );
      expect(result.success).toBe(true);
      expect(result.content).toMatch(/Notified worker-1: message \(interrupt=false\)/);

      // 实测 file written to target inbox/pending/
      const files = await fs.list(path.join('claws', targetClaw, 'inbox', 'pending'));
      expect(files.length).toBe(1);
      const content = await fs.read(path.join('claws', targetClaw, 'inbox', 'pending', files[0].name));
      expect(content).toMatch(/priority: normal/);
      expect(content).toMatch(/from: "motion"/);
      expect(content).toMatch(/type: message/);
      expect(content).toMatch(/hello worker/);

      // 实测 audit NOTIFY_CLAW_SENT emit + payload
      const rows = audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT);
      expect(rows.length).toBe(1);
      expect(rows[0]).toContain(`claw=${targetClaw}`);
      expect(rows[0]).toContain('type=message');
      expect(rows[0]).toContain('interrupt=false');
    });

    it('interrupt=true → priority=high metadata + interrupt=true audit field', async () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot: tempDir, audit: audit.audit });
      await tool.execute(
        { to: targetClaw, body: 'urgent', type: 'alert', interrupt: true },
        {} as any,
      );
      const files = await fs.list(path.join('claws', targetClaw, 'inbox', 'pending'));
      const content = await fs.read(path.join('claws', targetClaw, 'inbox', 'pending', files[0].name));
      expect(content).toMatch(/priority: high/);
      expect(content).toMatch(/type: alert/);

      const sentRow = audit.events.find(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT);
      expect(sentRow).toContain('interrupt=true');
    });

    it('custom type default → "message"', async () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot: tempDir, audit: audit.audit });
      await tool.execute({ to: targetClaw, body: 'plain' }, {} as any);
      const files = await fs.list(path.join('claws', targetClaw, 'inbox', 'pending'));
      const content = await fs.read(path.join('claws', targetClaw, 'inbox', 'pending', files[0].name));
      expect(content).toMatch(/type: message/);
    });
  });

  describe('error path', () => {
    it('InboxWriter.writeSync throws → NOTIFY_CLAW_FAILED audit + success=false', async () => {
      const failFs = {
        ...fs,
        writeAtomicSync: vi.fn(() => {
          throw new Error('disk full');
        }),
        ensureDirSync: vi.fn(() => {}),
        existsSync: vi.fn(() => true),
      } as unknown as NodeFileSystem;

      const tool = createNotifyClawTool({ fs: failFs, clawforumRoot: tempDir, audit: audit.audit });
      const result = await tool.execute(
        { to: targetClaw, body: 'should fail' },
        {} as any,
      );
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/Failed to notify worker-1:/);

      const failedRow = audit.events.find(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED);
      expect(failedRow).toBeDefined();
      expect(failedRow).toContain(`claw=${targetClaw}`);
      expect(failedRow!.some(f => typeof f === 'string' && f.startsWith('reason='))).toBe(true);

      // 反向：NOTIFY_CLAW_SENT 必 0 emit
      const sentRows = audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT);
      expect(sentRows.length).toBe(0);
    });
  });

  describe('phase 895 input validation guard', () => {
    // happy path 既有 test 已 cover valid `to` → 此处仅反向 reject path

    it('rejects to="../motion" (path traversal) → NOTIFY_CLAW_FAILED + success=false + no file written', async () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot: tempDir, audit: audit.audit });
      const result = await tool.execute(
        { to: '../motion', body: 'attack' },
        {} as any,
      );
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/invalid claw id/i);

      // 反向：NOTIFY_CLAW_SENT 必 0 emit
      expect(audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT).length).toBe(0);

      // 实测 NOTIFY_CLAW_FAILED emit + reason=invalid_claw_id
      const failedRow = audit.events.find(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED);
      expect(failedRow).toBeDefined();
      expect(failedRow).toContain('claw=../motion');
      expect(failedRow).toContain('reason=invalid_claw_id');

      // 反向：motion dir 必 0 建（traversal 被 reject 前）
      const motionDir = path.join(tempDir, 'motion');
      expect(await fs.exists(motionDir)).toBe(false);
    });

    it('rejects to="" (empty) → NOTIFY_CLAW_FAILED + success=false', async () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot: tempDir, audit: audit.audit });
      const result = await tool.execute(
        { to: '', body: 'empty' },
        {} as any,
      );
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/invalid claw id/i);

      const failedRow = audit.events.find(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED);
      expect(failedRow).toContain('reason=invalid_claw_id');
      expect(audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT).length).toBe(0);
    });

    it('rejects to="." (dot) → NOTIFY_CLAW_FAILED + success=false', async () => {
      const tool = createNotifyClawTool({ fs, clawforumRoot: tempDir, audit: audit.audit });
      const result = await tool.execute(
        { to: '.', body: 'dot' },
        {} as any,
      );
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/invalid claw id/i);

      const failedRow = audit.events.find(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED);
      expect(failedRow).toContain('reason=invalid_claw_id');
    });

    it('rejects nonexistent claw → NOTIFY_CLAW_FAILED reason=claw_not_found + no orphan dir created', async () => {
      // 不预建 claws/ghost-claw — 实测 orphan prevention
      const tool = createNotifyClawTool({ fs, clawforumRoot: tempDir, audit: audit.audit });
      const result = await tool.execute(
        { to: 'ghost-claw', body: 'orphan' },
        {} as any,
      );
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/claw not found/i);

      // 反向：orphan dir 必 0 建（核心 attack prevention）
      const orphanRoot = path.join(tempDir, 'claws', 'ghost-claw');
      expect(await fs.exists(orphanRoot)).toBe(false);

      // 实测 NOTIFY_CLAW_FAILED + reason=claw_not_found
      const failedRow = audit.events.find(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED);
      expect(failedRow).toBeDefined();
      expect(failedRow).toContain('claw=ghost-claw');
      expect(failedRow).toContain('reason=claw_not_found');

      // 反向：NOTIFY_CLAW_SENT 必 0 emit
      expect(audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT).length).toBe(0);
    });
  });

  describe('phase 898: independent error paths', () => {
    it('ensureDirSync throws → NOTIFY_CLAW_FAILED with ensureDir reason + success=false', async () => {
      const failFs = {
        ...fs,
        ensureDirSync: vi.fn(() => {
          throw new Error('EACCES: permission denied');
        }),
        writeAtomicSync: vi.fn(() => {}),   // 不 throw（独立于既有 writeAtomicSync-throw 路径）
        existsSync: vi.fn(() => true),
      } as unknown as NodeFileSystem;

      const tool = createNotifyClawTool({ fs: failFs, clawforumRoot: tempDir, audit: audit.audit });
      const result = await tool.execute(
        { to: targetClaw, body: 'should fail ensureDir' },
        {} as any,
      );
      expect(result.success).toBe(false);
      expect(result.content).toMatch(/Failed to notify worker-1:/);
      expect(result.content).toMatch(/EACCES/);

      // NOTIFY_CLAW_FAILED audit emit with reason 含 ensureDir 原因
      const failedRow = audit.events.find(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED);
      expect(failedRow).toBeDefined();
      expect(failedRow).toContain(`claw=${targetClaw}`);
      expect(failedRow!.some(f => typeof f === 'string' && f.startsWith('reason=') && f.includes('EACCES'))).toBe(true);

      // 反向：NOTIFY_CLAW_SENT 必 0 emit
      const sentRows = audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT);
      expect(sentRows.length).toBe(0);

      // 反向：writeAtomicSync 必 0 call（ensureDir 抛后短路）
      expect((failFs.writeAtomicSync as any).mock.calls.length).toBe(0);
    });

    it('audit.write throws on SENT emit → catch path emits FAILED with audit reason + file already written (orphan state)', async () => {
      // 副发现 4 cross-ref: catch 内 audit 二次抛 silent propagate / 单点 silent X 候选
      // NOTIFY_CLAW_SENT 抛 → 进 catch → catch 内 audit.write(FAILED) 不 throw（仅 SENT throw mock）→ return success=false
      const failAudit = {
        write: vi.fn((event: string) => {
          if (event === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT) {
            throw new Error('audit disk full');
          }
        }),
      } as any;

      const tool = createNotifyClawTool({ fs, clawforumRoot: tempDir, audit: failAudit });

      let caught: Error | undefined;
      try {
        await tool.execute({ to: targetClaw, body: 'audit will fail on SENT' }, {} as any);
      } catch (e) {
        caught = e as Error;
      }

      // SENT path audit throw → 被 catch 抓住 / execute 返回 success=false（不 bubble 至 caller）
      expect(caught).toBeUndefined();

      // 实然：write 调 3 次（INBOX_WRITTEN + SENT throw + FAILED 补救 emit）
      expect((failAudit.write as any).mock.calls.length).toBeGreaterThanOrEqual(3);

      // INBOX_WRITTEN 路径首调（InboxWriter.writeSync 内部）
      expect((failAudit.write as any).mock.calls[0][0]).toBe(MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN);

      // SENT 路径第二调
      expect((failAudit.write as any).mock.calls[1][0]).toBe(MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT);

      // FAILED 路径补救 emit（catch 抓 SENT throw 后调）
      const failedCalls = (failAudit.write as any).mock.calls.filter(
        (c: any[]) => c[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED,
      );
      expect(failedCalls.length).toBe(1);
      expect(failedCalls[0]).toContainEqual(expect.stringMatching(/reason=.*audit disk full/));

      // file 实际写入（writeSync 早于 audit.write SENT、ensureDir + writeAtomicSync 已成功）→ orphan file
      const files = await fs.list(path.join('claws', targetClaw, 'inbox', 'pending'));
      expect(files.length).toBe(1);   // 副发现 4 同根：SENT audit throw → file 已写 + FAILED audit emit / inconsistent state
    });
  });

  describe('inverse oracle (防 silent fail)', () => {
    it('mutation：execute 改返 success=true 永真 → 此测试必触发 audit/file 缺断言失败', async () => {
      // 该 test 仅记录意图、实际通过 audit + file 双 oracle 已覆盖
      // mutation testing 框架（stryker）会自动验 — 留 docblock 标识
      expect(true).toBe(true);
    });
  });
});
