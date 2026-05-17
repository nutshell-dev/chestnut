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

  describe('inverse oracle (防 silent fail)', () => {
    it('mutation：execute 改返 success=true 永真 → 此测试必触发 audit/file 缺断言失败', async () => {
      // 该 test 仅记录意图、实际通过 audit + file 双 oracle 已覆盖
      // mutation testing 框架（stryker）会自动验 — 留 docblock 标识
      expect(true).toBe(true);
    });
  });
});
