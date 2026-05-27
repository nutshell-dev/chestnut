/**
 * Phase 1132 D.2: codec-inbox cross-key fallback 删除 + legacy claw_id extraMeta marker
 *
 * 反向测试：
 * 1. 仅 claw_id present → contract_id undefined + extraMeta.__legacy_claw_id = claw_id
 * 2. 仅 contract_id present → contract_id = value + 无 __legacy_claw_id
 * 3. 双 present → contract_id = meta.contract_id + __legacy_claw_id = meta.claw_id
 * 4. inbox-reader 扫描 legacy fixture → INBOX_LEGACY_CLAW_ID_FIELD audit emit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { InboxReader, InboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';

describe('phase 1132 D.2: codec-inbox legacy claw_id', () => {
  it('case 1: 仅 claw_id present → contract_id undefined + extraMeta.__legacy_claw_id', () => {
    const raw = `---\nid: msg-1\ntype: heartbeat\nfrom: system\nto: claw1\npriority: normal\ntimestamp: 2026-05-20T00:00:00Z\nclaw_id: claw1\n---\n\nbody\n`;
    const msg = decodeInbox(raw);
    expect(msg.metadata?.contract_id).toBeUndefined();
    expect(msg.extraMeta?.__legacy_claw_id).toBe('claw1');
  });

  it('case 2: 仅 contract_id present → contract_id = value + 无 __legacy_claw_id', () => {
    const raw = `---\nid: msg-2\ntype: message\nfrom: sender\nto: claw1\npriority: high\ntimestamp: 2026-05-20T00:00:00Z\ncontract_id: contract-42\n---\n\nbody\n`;
    const msg = decodeInbox(raw);
    expect(msg.metadata?.contract_id).toBe('contract-42');
    expect(msg.extraMeta?.__legacy_claw_id).toBeUndefined();
  });

  it('case 3: 双 present → contract_id = meta.contract_id + __legacy_claw_id = meta.claw_id', () => {
    const raw = `---\nid: msg-3\ntype: message\nfrom: sender\nto: claw1\npriority: normal\ntimestamp: 2026-05-20T00:00:00Z\ncontract_id: contract-42\nclaw_id: claw1\n---\n\nbody\n`;
    const msg = decodeInbox(raw);
    expect(msg.metadata?.contract_id).toBe('contract-42');
    expect(msg.extraMeta?.__legacy_claw_id).toBe('claw1');
  });
});

describe('phase 1132 D.2: inbox-reader legacy claw_id audit', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: Array<{ type: string; cols: string[] }>;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `inbox-legacy-claw-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    const audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push({ type, cols: cols.map(String) });
      },
    };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit);
    reader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      audit,
    );
    await reader.init();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('case 4: legacy claw_id 文件触发 INBOX_LEGACY_CLAW_ID_FIELD audit', async () => {
    // 写一条带 claw_id 的 legacy format 消息
    const raw = `---\nid: msg-legacy\ntype: heartbeat\nfrom: system\nto: claw1\npriority: normal\ntimestamp: 2026-05-20T00:00:00Z\nclaw_id: claw1\n---\n\nheartbeat body\n`;
    const pendingFile = path.join(testDir, 'inbox', 'pending', 'legacy_msg.md');
    await fs.mkdir(path.dirname(pendingFile), { recursive: true });
    await fs.writeFile(pendingFile, raw, 'utf-8');

    const results = await reader.drainInbox();

    expect(results).toHaveLength(1);
    expect(results[0].message.metadata?.contract_id).toBeUndefined();
    expect(results[0].message.extraMeta?.__legacy_claw_id).toBe('claw1');

    const legacyAudit = auditCalls.filter(
      (c) => c.type === MESSAGING_AUDIT_EVENTS.INBOX_LEGACY_CLAW_ID_FIELD,
    );
    expect(legacyAudit).toHaveLength(1);
    expect(legacyAudit[0].cols.some((c) => c.includes('claw_id=claw1'))).toBe(true);
  });
});
