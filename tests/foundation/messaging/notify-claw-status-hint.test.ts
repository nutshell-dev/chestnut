/**
 * notify_claw tool status hint + wrapper migration tests (phase 232)
 *
 * Invariants:
 * 1. notify_claw tool uses notifyClaw wrapper (M#3 SoT)
 * 2. status hint appended when target claw not alive
 * 3. status hint omitted when target claw alive
 * 4. DLQ + audit emit behavior preserved via wrapper inherit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { createNotifyClawTool } from '../../../src/foundation/messaging/tools/notify-claw.js';
import { formatClawStatusHint } from '../../../src/cli/commands/claw-shared.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { routeNotifyClaw } from '../../../src/core/claw-topology/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('notify_claw tool status hint (phase 232)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  const targetClaw = 'worker-1';
  const motionCtx = { callerLabel: 'motion' } as any;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    await fs.ensureDir(path.join('claws', targetClaw));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  const defaultDeps = {
    formatClawStatusHint,
    clawExists: () => true,
    hasActiveContract: () => false,
    defaultSource: 'motion', isCallerAuthorized: (label: string) => label === 'motion',
  };

  function makeTool(auditLog: any, overrides: Record<string, unknown> = {}) {
    return createNotifyClawTool({
      ...defaultDeps,
      fs,
      notifyClaw: (targetClawId: string, message: any) =>
        routeNotifyClaw(fs, tempDir, 'motion', targetClawId, message, auditLog),
      audit: auditLog,
      ...overrides,
    });
  }

  describe('status hint', () => {
    it('return content 含 hint when target claw not alive', async () => {
      const tool = makeTool(audit.audit, {
        isClawAlive: () => false,
      });
      const result = await tool.execute(
        { to: targetClaw, body: 'hello worker' },
        motionCtx,
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain('Notified worker-1');
      expect(result.content).toContain(
        'Note: claw "worker-1" is not running. Start it with: chestnut claw worker-1 daemon',
      );
    });

    it('return content 不含 hint when target claw alive', async () => {
      const tool = makeTool(audit.audit, {
        isClawAlive: () => true,
      });
      const result = await tool.execute(
        { to: targetClaw, body: 'hello worker' },
        motionCtx,
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain('Notified worker-1');
      expect(result.content).not.toContain('Note:');
    });
  });

  describe('wrapper migration (M#3)', () => {
    it('calls notifyClaw wrapper — file written to target inbox', async () => {
      const tool = makeTool(audit.audit, {
        isClawAlive: () => true,
      });
      const result = await tool.execute(
        { to: targetClaw, body: 'wrapper msg' },
        motionCtx,
      );
      expect(result.success).toBe(true);

      const files = await fs.list(path.join('claws', targetClaw, 'inbox', 'pending'));
      expect(files.length).toBe(1);
      const content = await fs.read(path.join('claws', targetClaw, 'inbox', 'pending', files[0].name));
      expect(content).toMatch(/wrapper msg/);
    });

    it('NOTIFY_CLAW_SENT audit emit preserved after wrapper migration', async () => {
      const tool = makeTool(audit.audit, {
        isClawAlive: () => true,
      });
      await tool.execute(
        { to: targetClaw, body: 'audit check' },
        motionCtx,
      );
      const sentRows = audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT);
      expect(sentRows.length).toBe(1);
      expect(sentRows[0]).toContain(`claw=${targetClaw}`);
    });

    it('DLQ for unknown destination preserved via clawExists callback (phase 241)', async () => {
      const tool = makeTool(audit.audit, {
        clawExists: () => false,
        isClawAlive: () => true,
      });
      const result = await tool.execute(
        { to: 'ghost-claw', body: 'orphan' },
        motionCtx,
      );
      expect(result.success).toBe(false);
      expect(result.content).toBe('Failed to notify ghost-claw: claw "ghost-claw" does not exist');
      const orphanRoot = path.join(tempDir, 'claws', 'ghost-claw');
      expect(await fs.exists(orphanRoot)).toBe(false);
    });
  });

  describe('phase 241: active contract hint', () => {
    it('return content 含 contract hint when alive but no active contract', async () => {
      const tool = makeTool(audit.audit, {
        isClawAlive: () => true,
        hasActiveContract: () => false,
      });
      const result = await tool.execute(
        { to: targetClaw, body: 'hello worker' },
        motionCtx,
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain('Notified worker-1');
      expect(result.content).toContain(
        'No active contract for "worker-1". Ask claw to reply via send tool in message body.',
      );
    });

    it('return content 不含 contract hint when alive + has active contract', async () => {
      const tool = makeTool(audit.audit, {
        isClawAlive: () => true,
        hasActiveContract: () => true,
      });
      const result = await tool.execute(
        { to: targetClaw, body: 'hello worker' },
        motionCtx,
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain('Notified worker-1');
      expect(result.content).not.toContain('active contract');
    });

    it('return content 含 status hint but not contract hint when stopped (not alive)', async () => {
      const tool = makeTool(audit.audit, {
        isClawAlive: () => false,
        hasActiveContract: () => false,
      });
      const result = await tool.execute(
        { to: targetClaw, body: 'hello worker' },
        motionCtx,
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain('Notified worker-1');
      expect(result.content).toContain('Note: claw "worker-1" is not running');
      expect(result.content).not.toContain('active contract');
    });
  });
});
