import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { StreamWriter, createStreamReader, STREAM_FILE, type StreamReader, type StreamEvent } from '../../src/foundation/stream/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createEventCollector } from '../helpers/event-collector.js';
import { STREAM_AUDIT_EVENTS } from '../../src/foundation/stream/audit-events.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

describe('StreamReader', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let writer: StreamWriter;
  let reader: StreamReader | null = null;
  const ec = createEventCollector<StreamEvent>();

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    writer = new StreamWriter(fs, makeAudit().audit);
    ec.reset();
  });

  afterEach(async () => {
    if (reader) {
      await reader.stop();
      reader = null;
    }
    writer.close();
    await cleanupTempDir(tempDir);
    ec.reset();
  });

  async function makeReadyReader(
    fs: NodeFileSystem,
    onEvent: (e: StreamEvent) => void,
    audit: AuditLog,
  ): Promise<StreamReader> {
    return new Promise((resolve) => {
      const r = createStreamReader(fs, STREAM_FILE, onEvent, audit, {
        onReady: () => resolve(r),
      });
      r.start();
    });
  }

  it('should receive new events after start', async () => {
    writer.open();
    reader = await makeReadyReader(fs, ec.onEvent, makeAudit().audit);

    const ev: StreamEvent = { ts: Date.now(), type: 'test', value: 42 };
    writer.write(ev);

    await ec.whenCount(1);
    expect(ec.events[0]).toMatchObject({ type: 'test', value: 42 });
  });

  it('should not replay existing content', async () => {
    writer.open();
    writer.write({ ts: 1, type: 'old1' });
    writer.write({ ts: 2, type: 'old2' });
    writer.write({ ts: 3, type: 'old3' });

    reader = await makeReadyReader(fs, ec.onEvent, makeAudit().audit);

    writer.write({ ts: 5, type: 'new' });

    await ec.whenCount(1);
    expect(ec.events[0].type).toBe('new');
  });

  it('should receive multiple batched events in order', async () => {
    writer.open();
    reader = await makeReadyReader(fs, ec.onEvent, makeAudit().audit);

    for (let i = 0; i < 5; i++) {
      writer.write({ ts: i, type: 'batch', idx: i });
    }

    await ec.whenCount(5);
    expect(ec.events.map(e => (e as StreamEvent & { idx: number }).idx)).toEqual([0, 1, 2, 3, 4]);
  });

  it('should isolate JSON parse errors and keep processing', async () => {
    const { audit, events: auditEvents } = makeAudit();
    writer.open();
    reader = await makeReadyReader(fs, ec.onEvent, audit);

    // write a valid event first
    writer.write({ ts: 1, type: 'before' });
    await ec.whenCount(1);

    // append an invalid JSON line followed by a valid one directly via fs
    // 合并 2 appendSync → 单 batched call / 消 chokidar event coalescing race in CI
    // reader 仍 read batch + parse 各 line（fail invalid + succeed valid）/ parse error isolation 语义保留
    const batchedContent =
      'this is not json\n' +
      JSON.stringify({ ts: 2, type: 'after' }) + '\n';
    fs.appendSync('stream.jsonl', batchedContent);

    await ec.whenCount(2);
    expect(ec.events[1].type).toBe('after');
    expect(auditEvents.some(e => e[0] === STREAM_AUDIT_EVENTS.READER_PARSE_FAILED)).toBe(true);
  });

  it('onEvent callback error triggers stream_reader_callback_failed', async () => {
    const { audit, events: auditEvents } = makeAudit();
    writer.open();
    let callCount = 0;
    reader = createStreamReader(fs, STREAM_FILE, (ev) => {
      callCount++;
      if (callCount === 1) throw new Error('cb boom');
      ec.onEvent(ev);
    }, audit);
    reader.start();

    await new Promise(r => setTimeout(r, 300)); // sleep: let reader finish probe pattern

    writer.write({ ts: 1, type: 'first' });
    writer.write({ ts: 2, type: 'second' });

    await ec.whenCount(1);
    expect(ec.events[0].type).toBe('second');
    expect(auditEvents.some(e => e[0] === STREAM_AUDIT_EVENTS.READER_CALLBACK_FAILED)).toBe(true);
  });

  it('should enforce start/stop lifecycle', async () => {
    reader = createStreamReader(fs, STREAM_FILE, ec.onEvent, makeAudit().audit);

    expect(reader.isActive()).toBe(false);

    reader.start();
    expect(reader.isActive()).toBe(true);

    expect(() => reader!.start()).toThrow('StreamReader already started');

    await reader.stop();
    expect(reader.isActive()).toBe(false);

    // repeated stop is idempotent
    await reader.stop();
    expect(reader.isActive()).toBe(false);
  });
});
