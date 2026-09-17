import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { OutboxWriter } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../src/foundation/messaging/audit-events.js';
import { makeAudit } from '../helpers/audit.js';
import { decodeOutbox } from '../../src/foundation/messaging/codec-outbox.js';

const UUID_V4_RE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function extractUuid(filename: string): string | undefined {
  const match = filename.match(new RegExp(`(${UUID_V4_RE})\\.md$`, 'i'));
  return match?.[1];
}

describe('OutboxWriter', () => {
  let tmpDir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('ob-test-');
    fs = new NodeFileSystem({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it('write success creates file in outbox/pending/ and audits OUTBOX_SENT', async () => {
    const { audit, events } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit, MESSAGING_WRITER_LIMITS_DEFAULT);

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

  it('write with contract_id keeps metadata opaque: passthrough in file, no business key in audit', async () => {
    const { audit, events } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit, MESSAGING_WRITER_LIMITS_DEFAULT);

    const filePath = await writer.write({
      type: 'contract_update',
      to: 'claw-b',
      content: 'Update',
      metadata: { contract_id: 'contract-123' },
    });

    // phase 1851 Step B: metadata opaque passthrough unchanged (codec round-trip)
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toContain('contract_id: "contract-123"');
    // audit event records message identity only; business correlation is the producer's job
    const sent = events.find(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)!;
    expect(sent.some((c: any) => String(c).startsWith('id='))).toBe(true);
    expect(sent.some((c: any) => String(c).includes('type=contract_update'))).toBe(true);
    expect(sent.some((c: any) => String(c).includes('contract_id') || String(c).includes('contractId'))).toBe(false);
  });

  it('write failure audits OUTBOX_SEND_FAILED and throws', async () => {
    const { audit, events } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit, MESSAGING_WRITER_LIMITS_DEFAULT);

    // Mock writeAtomic to throw
    fs.writeAtomic = vi.fn(() => Promise.reject(new Error('disk full')));

    await expect(writer.write({ type: 'error', to: 'claw-b', content: 'Oops' })).rejects.toThrow('disk full');

    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SEND_FAILED)).toBe(true);
    const failed = events.find(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SEND_FAILED)!;
    expect(failed.some((c: any) => String(c).includes('reason=disk full'))).toBe(true);
  });

  it('creates outboxDir automatically when it does not exist', async () => {
    const { audit } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit, MESSAGING_WRITER_LIMITS_DEFAULT);

    await writer.write({ type: 'status_report', to: 'claw-b', content: 'OK' });

    const outboxDir = path.join(tmpDir, 'outbox', 'pending');
    const stat = await fsp.stat(outboxDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('write uses a single UUID for envelope id and filename suffix', async () => {
    const { audit } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit, MESSAGING_WRITER_LIMITS_DEFAULT);

    const filePath = await writer.write({ type: 'question', to: 'claw-b', content: '?' });
    const basename = path.basename(filePath);
    expect(basename).toMatch(new RegExp(`^\\d+_question_${UUID_V4_RE}\\.md$`, 'i'));

    const suffix = extractUuid(basename);
    expect(suffix).toBeDefined();

    const content = await fsp.readFile(filePath, 'utf-8');
    const decoded = decodeOutbox(content);
    expect(decoded.id).toBe(`claw-a-${suffix}`);
  });

  it('concurrent writes with frozen timestamp produce distinct files and no overwrites', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890123);
    const { audit } = makeAudit();
    const writer = createOutboxWriter('claw-a', tmpDir, fs, audit, MESSAGING_WRITER_LIMITS_DEFAULT);

    const writes = Array.from({ length: 5 }, (_, i) =>
      writer.write({ type: 'report', to: 'claw-b', content: `report ${i}` }),
    );

    await expect(Promise.all(writes)).resolves.not.toThrow();

    const outboxDir = path.join(tmpDir, 'outbox', 'pending');
    const files = await fsp.readdir(outboxDir);
    expect(files).toHaveLength(5);

    const suffixes = files.map(extractUuid);
    expect(new Set(suffixes).size).toBe(5);

    const contents: string[] = [];
    for (const file of files) {
      const content = await fsp.readFile(path.join(outboxDir, file), 'utf-8');
      const decoded = decodeOutbox(content);
      contents.push(decoded.content);
    }
    expect(contents.sort()).toEqual(['report 0', 'report 1', 'report 2', 'report 3', 'report 4']);
  });
});
