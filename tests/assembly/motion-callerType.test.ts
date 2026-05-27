import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { createNotifyClawTool } from '../../src/foundation/messaging/tools/notify-claw.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../helpers/audit.js';
import { CALLER_TYPE_TO_GROUPS } from '../../src/core/caller-types.js';

describe('motion callerType assemble fix (phase 1160 P0-1)', () => {
  let tempDir: string;
  let clawforumDir: string;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `motion-callerType-${randomUUID()}`);
    clawforumDir = path.join(tempDir, '.clawforum');
    fsNative.mkdirSync(clawforumDir, { recursive: true });
    audit = makeAudit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fsNative.rmSync(tempDir, { recursive: true, force: true });
  });

  // 反向 1: motion identity → callerType === motion (production wiring)
  it('反向 1: motion identity → callerLabel === motion', () => {
    const fs = new NodeFileSystem({ baseDir: clawforumDir });
    const ctx = new ExecContextImpl({
      clawId: 'motion',
      clawDir: path.join(clawforumDir, 'motion'),
      syncDir: path.join(clawforumDir, 'motion', 'tasks', 'sync'),
      profile: 'full',
      allowedGroups: CALLER_TYPE_TO_GROUPS.motion,
      callerLabel: 'motion',
      fs,
      maxSteps: 10,
      auditWriter: audit.audit,
    });
    expect(ctx.callerLabel).toBe('motion');
  });

  // 反向 2: claw identity → callerType === claw (regression guard)
  it('反向 2: claw identity → callerLabel === claw', () => {
    const fs = new NodeFileSystem({ baseDir: clawforumDir });
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: path.join(clawforumDir, 'claws', 'test-claw'),
      syncDir: path.join(clawforumDir, 'claws', 'test-claw', 'tasks', 'sync'),
      profile: 'full',
      allowedGroups: CALLER_TYPE_TO_GROUPS.claw,
      callerLabel: 'claw',
      fs,
      maxSteps: 10,
      auditWriter: audit.audit,
    });
    expect(ctx.callerLabel).toBe('claw');
  });

  // 反向 3: motion → notify-claw guard passes (end-to-end)
  it('反向 3: motion callerLabel → notify-claw guard passes', async () => {
    const fs = new NodeFileSystem({ baseDir: clawforumDir });
    await fs.ensureDir('claws/target-claw');

    const ctx = new ExecContextImpl({
      clawId: 'motion',
      clawDir: path.join(clawforumDir, 'motion'),
      syncDir: path.join(clawforumDir, 'motion', 'tasks', 'sync'),
      profile: 'full',
      allowedGroups: CALLER_TYPE_TO_GROUPS.motion,
      callerLabel: 'motion',
      fs,
      maxSteps: 10,
      auditWriter: audit.audit,
    });

    const tool = createNotifyClawTool({
      fs,
      clawforumRoot: clawforumDir,
      audit: audit.audit,
    });

    const result = await tool.execute(
      { to: 'target-claw', body: 'hello' },
      ctx,
    );

    expect(result.success).toBe(true);
    const sentRows = audit.events.filter(
      r => r[0] === 'notify_claw_sent',
    );
    expect(sentRows.length).toBe(1);
  });

  // 反向 4: claw callerType → notify-claw guard rejects (regression)
  it('反向 4: claw callerLabel → notify-claw guard rejects', async () => {
    const fs = new NodeFileSystem({ baseDir: clawforumDir });
    await fs.ensureDir('claws/target-claw');

    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: path.join(clawforumDir, 'claws', 'test-claw'),
      syncDir: path.join(clawforumDir, 'claws', 'test-claw', 'tasks', 'sync'),
      profile: 'full',
      allowedGroups: CALLER_TYPE_TO_GROUPS.claw,
      callerLabel: 'claw',
      fs,
      maxSteps: 10,
      auditWriter: audit.audit,
    });

    const tool = createNotifyClawTool({
      fs,
      clawforumRoot: clawforumDir,
      audit: audit.audit,
    });

    const result = await tool.execute(
      { to: 'target-claw', body: 'hello' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.content).toBe('notify_claw is motion-only');
  });
});
