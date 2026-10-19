/**
 * Phase 1955 Step D：contract_created 稳定业务身份、重投递 Resume 呈现与
 * inbox 幂等落盘的全链路验收。
 *
 * 覆盖：
 *  1. 稳定 message_id：同一 messageId 第二次写入 pending 不产生新文件（INBOX_DEDUPED）。
 *  2. nack 重投递递增 delivery_attempts，保留首次 timestamp。
 *  3. ContractSystem formatter：attempts=0 → New；attempts>0 → Resuming。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  InboxReader,
  InboxWriter,
  makeInboxPath,
  MESSAGING_WRITER_LIMITS_DEFAULT,
  renderStandardInboxMessage,
} from '../../../src/foundation/messaging/index.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { contractCreatedInboxFormatter } from '../../../src/core/contract/inbox-formatters.js';
import { contractCreatedNotificationBody } from '../../../src/templates/messages/index.js';

describe('Phase 1955 Step D: contract_created idempotency', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: Array<{ type: string; cols: string[] }>;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `contract-idem-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    const audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push({ type, cols: cols.map(String) });
      },
    };
    writer = InboxWriter.__internal_create(
      nfs,
      makeInboxPath(INBOX_PENDING_DIR),
      audit,
      MESSAGING_WRITER_LIMITS_DEFAULT,
    );
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
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function contractPayload() {
    return {
      type: 'contract_created' as const,
      source: 'system',
      priority: 'high' as const,
      body: contractCreatedNotificationBody({
        contractId: 'c-1',
        title: 'T',
        goal: 'G',
        subtasks: [{ id: 's1', description: 'first' }],
        createdAt: '2026-10-19T00:00:00.000Z',
      }),
      messageId: 'contract:c-1:created',
      metadata: {
        idempotency_key: 'contract:c-1:contract_created',
        contract_id: 'c-1',
        created_at: '2026-10-19T00:00:00.000Z',
        delivery_attempts: '0',
      },
    };
  }

  it('同一 messageId 在 pending 中只落盘一次（幂等业务身份）', async () => {
    const first = writer.writeSync(contractPayload());
    const second = writer.writeSync(contractPayload());

    expect(second).toBe(first);
    const files = (await fs.readdir(path.join(testDir, 'inbox', 'pending')))
      .filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);

    const decoded = InboxWriter.readMeta(nfs, path.join('inbox', 'pending', first));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.id).toBe('contract:c-1:created');
    expect(decoded.value.idempotency_key).toBe('contract:c-1:contract_created');

    expect(auditCalls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED)).toBe(true);
  });

  it('nack 重投递递增 delivery_attempts，首次 timestamp 不变', async () => {
    writer.writeSync(contractPayload());
    const firstDrain = await reader.drainAndDeliver();
    expect(firstDrain.handles).toHaveLength(1);

    // 从 inflight 读取原始 timestamp（文件以原始名存在于 inflight）
    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(1);
    const metaBefore = InboxWriter.readMeta(
      nfs,
      path.join(testDir, 'inbox', 'inflight', inflightFiles[0]),
    );
    expect(metaBefore.ok).toBe(true);
    if (!metaBefore.ok) return;

    await reader.nack(firstDrain.handles[0], 'rollback');

    const pendingFiles = (await fs.readdir(path.join(testDir, 'inbox', 'pending')))
      .filter(f => f.endsWith('.md'));
    expect(pendingFiles).toHaveLength(1);
    const metaAfter = InboxWriter.readMeta(
      nfs,
      path.join(testDir, 'inbox', 'pending', pendingFiles[0]),
    );
    expect(metaAfter.ok).toBe(true);
    if (!metaAfter.ok) return;
    expect(metaAfter.value.delivery_attempts).toBe('1');
    expect(metaAfter.value.timestamp).toBe(metaBefore.value.timestamp);
    expect(metaAfter.value.id).toBe('contract:c-1:created');
  });

  it('formatter：首次 New，重投递 Resuming（模板不读磁盘）', async () => {
    const body = contractPayload().body;
    const fresh = await contractCreatedInboxFormatter({
      from: 'system',
      body,
      timestampSec: '',
      metadata: { delivery_attempts: '0' },
    });
    expect(fresh).toContain('New contract created (c-1): T');
    expect(fresh).not.toContain('Resuming contract');

    const resumed = await contractCreatedInboxFormatter({
      from: 'system',
      body,
      timestampSec: '',
      metadata: { delivery_attempts: '1' },
    });
    expect(resumed).toContain('Resuming contract (c-1): T');
    expect(resumed).not.toContain('New contract created');
    expect(resumed).toContain('Created at: 2026-10-19T00:00:00.000Z');
    expect(resumed).toBe(renderStandardInboxMessage(
      { from: 'system', body: body.replace(/^New contract created/, 'Resuming contract'), timestampSec: '' },
      'system',
    ));
  });
});
