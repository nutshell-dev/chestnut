import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { OutboxWriter } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../src/foundation/messaging/audit-events.js';
import { makeAudit } from '../helpers/audit.js';

describe('OutboxWriter', () => {
  let tmpDir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-test-'));
    fs = new NodeFileSystem({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('write success creates file in outbox/pending/ and audits OUTBOX_SENT', async () => {
    const { audit, events } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit);

    const filePath = await writer.write({
      type: 'response',
      to: 'claw-b',
      content: 'Hello',
    });

    expect(filePath).toContain('outbox/pending/');
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toContain('Hello');

    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)).toBe(true);
    const sent = events.find(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)!;
    expect(sent.some((c: any) => String(c).includes('from=claw-a'))).toBe(true);
    expect(sent.some((c: any) => String(c).includes('to=claw-b'))).toBe(true);
    expect(sent.some((c: any) => String(c).includes('type=response'))).toBe(true);
  });

  it('write with contract_id includes contract_id column in audit', async () => {
    const { audit, events } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit);

    await writer.write({
      type: 'contract_update',
      to: 'claw-b',
      content: 'Update',
      metadata: { contract_id: 'contract-123' },
    });

    const sent = events.find(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)!;
    expect(sent.some((c: any) => String(c).includes('contractId=contract-123'))).toBe(true);
  });

  it('write failure audits OUTBOX_SEND_FAILED and throws', async () => {
    const { audit, events } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit);

    // Mock writeAtomic to throw
    fs.writeAtomic = vi.fn(() => Promise.reject(new Error('disk full')));

    await expect(writer.write({ type: 'error', to: 'claw-b', content: 'Oops' })).rejects.toThrow('disk full');

    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SEND_FAILED)).toBe(true);
    const failed = events.find(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SEND_FAILED)!;
    expect(failed.some((c: any) => String(c).includes('reason=disk full'))).toBe(true);
  });

  it('creates outboxDir automatically when it does not exist', async () => {
    const { audit } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit);

    await writer.write({ type: 'status_report', to: 'claw-b', content: 'OK' });

    const outboxDir = path.join(tmpDir, 'outbox', 'pending');
    const stat = await fsp.stat(outboxDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('includes message id in filename', async () => {
    const { audit } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit);

    const filePath = await writer.write({ type: 'question', to: 'claw-b', content: '?' });
    const basename = path.basename(filePath);
    expect(basename).toMatch(/^\d+_question_[a-f0-9]{8}\.md$/);
  });
});
