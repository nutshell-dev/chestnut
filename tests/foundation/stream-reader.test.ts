import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as nativeFs } from 'node:fs';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { StreamWriter, createStreamReader, type StreamReader, type StreamEvent } from '../../src/foundation/stream/index.js';
import { makeAudit } from '../helpers/audit.js';
import { AUDIT_EVENTS } from '../../src/foundation/audit/events.js';

const TIMEOUT_MS = 10000;

function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        if (await condition()) {
          resolve();
          return;
        }
      } catch {
        // continue polling
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

describe('StreamReader', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let writer: StreamWriter;
  let reader: StreamReader | null = null;
  const events: StreamEvent[] = [];

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    writer = new StreamWriter(fs, makeAudit().audit);
    events.length = 0;
  });

  afterEach(async () => {
    if (reader) {
      await reader.stop();
      reader = null;
    }
    writer.close();
    await cleanupTempDir(tempDir);
    events.length = 0;
  });

  it('should receive new events after start', async () => {
    writer.open();
    reader = createStreamReader(fs, (ev) => events.push(ev), makeAudit().audit);
    reader.start();

    // give chokidar watcher time to initialize before writing
    await new Promise(r => setTimeout(r, 300));

    const ev: StreamEvent = { ts: Date.now(), type: 'test', value: 42 };
    writer.write(ev);

    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'test', value: 42 });
  });

  it('should not replay existing content', async () => {
    writer.open();
    writer.write({ ts: 1, type: 'old1' });
    writer.write({ ts: 2, type: 'old2' });
    writer.write({ ts: 3, type: 'old3' });

    // wait a tick so file is fully written and watcher settled
    await new Promise(r => setTimeout(r, 150));

    reader = createStreamReader(fs, (ev) => events.push(ev), makeAudit().audit);
    reader.start();

    // give watcher time to initialize
    await new Promise(r => setTimeout(r, 150));

    writer.write({ ts: 4, type: 'new' });

    await waitFor(() => events.length === 1);
    expect(events[0].type).toBe('new');
  });

  it('should receive multiple batched events in order', async () => {
    writer.open();
    reader = createStreamReader(fs, (ev) => events.push(ev), makeAudit().audit);
    reader.start();

    // give chokidar watcher time to initialize before writing
    await new Promise(r => setTimeout(r, 300));

    for (let i = 0; i < 5; i++) {
      writer.write({ ts: i, type: 'batch', idx: i });
    }

    await waitFor(() => events.length === 5);
    expect(events.map(e => (e as StreamEvent & { idx: number }).idx)).toEqual([0, 1, 2, 3, 4]);
  });

  it('should isolate JSON parse errors and keep processing', async () => {
    const { audit, events: auditEvents } = makeAudit();
    writer.open();
    reader = createStreamReader(fs, (ev) => events.push(ev), audit);
    reader.start();

    // give chokidar watcher time to initialize before writing
    await new Promise(r => setTimeout(r, 300));

    // write a valid event first
    writer.write({ ts: 1, type: 'before' });
    await waitFor(() => events.length === 1);

    // append an invalid JSON line followed by a valid one directly via fs
    fs.appendSync('stream.jsonl', 'this is not json\n');
    fs.appendSync('stream.jsonl', JSON.stringify({ ts: 2, type: 'after' }) + '\n');

    await waitFor(() => events.length === 2);
    expect(events[1].type).toBe('after');
    expect(auditEvents.some(e => e[0] === AUDIT_EVENTS.STREAM_READER_PARSE_FAILED)).toBe(true);
  });

  it('onEvent callback error triggers stream_reader_callback_failed', async () => {
    const { audit, events: auditEvents } = makeAudit();
    writer.open();
    let callCount = 0;
    reader = createStreamReader(fs, (ev) => {
      callCount++;
      if (callCount === 1) throw new Error('cb boom');
      events.push(ev);
    }, audit);
    reader.start();

    await new Promise(r => setTimeout(r, 300));

    writer.write({ ts: 1, type: 'first' });
    writer.write({ ts: 2, type: 'second' });

    await waitFor(() => events.length === 1);
    expect(events[0].type).toBe('second');
    expect(auditEvents.some(e => e[0] === AUDIT_EVENTS.STREAM_READER_CALLBACK_FAILED)).toBe(true);
  });

  it('emits appended events with < 50ms latency (immediate stability mode)', async () => {
    writer.open();
    reader = createStreamReader(fs, (ev) => events.push({ ...ev, _receivedAt: Date.now() } as any), makeAudit().audit);
    reader.start();

    // watcher 启动需要时间，但属于一次性成本
    await new Promise(r => setTimeout(r, 300));

    const sentAt = Date.now();
    writer.write({ ts: sentAt, type: 'latency_probe' });

    await waitFor(() => events.length === 1);
    const receivedAt = (events[0] as any)._receivedAt as number;
    const elapsed = receivedAt - sentAt;
    expect(elapsed).toBeLessThan(50);
  });

  it('should enforce start/stop lifecycle', async () => {
    reader = createStreamReader(fs, (ev) => events.push(ev), makeAudit().audit);

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
