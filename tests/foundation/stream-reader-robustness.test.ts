/**
 * StreamReader robustness / encoding / corrupt detection tests
 * (phase 1293 split from stream-reader.test.ts)
 *
 * 5 tests separated by natural semantic boundary:
 * - 多行中文 incremental write
 * - chunk 边界 UTF-8 + emoji StringDecoder
 * - 连续 ≥5 行畸形 JSON consecutive_fail trigger
 * - 近 RECENT_WINDOW parse fail ratio_high trigger
 *
 * Mirror phase 1292 chat-viewport-regression split / phase 1252 builtins-slow split.
 * Estimated split wall: 2 file parallel max ~2.4s (vs 4.4s baseline / -46%).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync as nativeAppend } from 'node:fs';
import * as nativePath from 'node:path';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { StreamWriter, createStreamReader, STREAM_FILE, type StreamReader, type StreamEvent } from '../../src/foundation/stream/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createEventCollector } from '../helpers/event-collector.js';
import { STREAM_AUDIT_EVENTS } from '../../src/foundation/stream/audit-events.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

/**
 * Inverse waitFor 窗口（断言 "no event emitted within window"）.
 * Derivation: > chokidar settle (100ms) + reader callback budget / 给 false-positive 假阳性窗口.
 */
const INVERSE_WAITFOR_WINDOW_MS = 200;

/**
 * chokidar batch boundary gap：appends 间留间隙以触 separate events（防 coalesce 合批）.
 * Derivation: > CHOKIDAR_STABILITY_THRESHOLD_MS (100ms? - 实际 chokidar default) 的一半 / 保 events 分批.
 */
const CHOKIDAR_BATCH_BOUNDARY_GAP_MS = 50;

describe('StreamReader — robustness/encoding/corrupt', () => {
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

  it('多行中文事件增量写入时，每行都通过 onEvent 到达', async () => {
    writer.open();
    const auditRec = makeAudit();
    reader = await makeReadyReader(fs, ec.onEvent, auditRec.audit);

    writer.write({ ts: 1, type: 'msg', text: '你好世界' });
    writer.write({ ts: 2, type: 'msg', text: '测试中文增量读取' });
    writer.write({ ts: 3, type: 'msg', text: '哈喽 🎯' });

    await ec.whenCount(3);

    expect(ec.events[0]).toMatchObject({ type: 'msg', text: '你好世界' });
    expect(ec.events[1]).toMatchObject({ type: 'msg', text: '测试中文增量读取' });
    expect(ec.events[2]).toMatchObject({ type: 'msg', text: '哈喽 🎯' });

    const parseFailed = auditRec.events.filter(([t]) => t === STREAM_AUDIT_EVENTS.READER_PARSE_FAILED);
    expect(parseFailed.length).toBe(0);
  });

  it('chunk 边界落在单个 UTF-8 字符字节中间时，StringDecoder 跨 read 复原', async () => {
    writer.open();
    const auditRec = makeAudit();
    reader = await makeReadyReader(fs, ec.onEvent, auditRec.audit);

    const prefix = Buffer.from('{"ts":1,"type":"t","text":"', 'utf-8');
    const charFirstByte = Buffer.from([0xe4]);
    const charRest = Buffer.from([0xb8, 0xad]);
    const suffix = Buffer.from('"}\n', 'utf-8');

    const streamAbs = nativePath.join(tempDir, STREAM_FILE);

    nativeAppend(streamAbs, Buffer.concat([prefix, charFirstByte]));

    await new Promise(r => setTimeout(r, INVERSE_WAITFOR_WINDOW_MS)); // inverse waitFor — assert no event emitted within window
    expect(ec.events.length).toBe(0);
    const partial_parseFailed = auditRec.events.filter(([t]) => t === STREAM_AUDIT_EVENTS.READER_PARSE_FAILED);
    expect(partial_parseFailed.length).toBe(0);

    nativeAppend(streamAbs, Buffer.concat([charRest, suffix]));

    await ec.whenCount(1);
    expect(ec.events[0]).toMatchObject({ type: 't', text: '中' });

    const parseFailed = auditRec.events.filter(([t]) => t === STREAM_AUDIT_EVENTS.READER_PARSE_FAILED);
    expect(parseFailed.length).toBe(0);
  });

  it('chunk 边界落在 4 字节 emoji 字节中间时，StringDecoder 跨 read 复原', async () => {
    writer.open();
    const auditRec = makeAudit();
    reader = await makeReadyReader(fs, ec.onEvent, auditRec.audit);

    const prefix = Buffer.from('{"ts":1,"type":"t","text":"', 'utf-8');
    const emojiHalf1 = Buffer.from([0xf0, 0x9f]);
    const emojiHalf2 = Buffer.from([0x8e, 0xaf]);
    const suffix = Buffer.from('"}\n', 'utf-8');

    const streamAbs = nativePath.join(tempDir, STREAM_FILE);

    nativeAppend(streamAbs, Buffer.concat([prefix, emojiHalf1]));
    await new Promise(r => setTimeout(r, INVERSE_WAITFOR_WINDOW_MS)); // inverse waitFor — assert no event emitted within window
    expect(ec.events.length).toBe(0);

    nativeAppend(streamAbs, Buffer.concat([emojiHalf2, suffix]));
    await ec.whenCount(1);
    expect(ec.events[0]).toMatchObject({ type: 't', text: '🎯' });

    const parseFailed = auditRec.events.filter(([t]) => t === STREAM_AUDIT_EVENTS.READER_PARSE_FAILED);
    expect(parseFailed.length).toBe(0);
  });

  it('连续 ≥5 行畸形 JSON 触发 STREAM_READER_CORRUPT（trigger=consecutive_fail） + 停订阅', async () => {
    writer.open();
    const auditRec = makeAudit();
    const auditEc = createEventCollector<[string, ...(string | number)[]]>();
    const wrappedAudit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        auditEc.onEvent([type, ...cols]);
        auditRec.audit.write(type, ...cols);
      },
      preview: (s: string) => auditRec.audit.preview(s),
      message: (s: string) => auditRec.audit.message(s),
      summary: (s: string) => auditRec.audit.summary(s),
    };
    reader = await makeReadyReader(fs, ec.onEvent, wrappedAudit);

    const streamAbs = nativePath.join(tempDir, STREAM_FILE);
    for (let i = 0; i < 5; i++) {
      nativeAppend(streamAbs, Buffer.from(`{broken_line_${i}\n`, 'utf-8'));
      // chokidar batch boundary: gap so appends fire as separate events (not coalesced)
      await new Promise(r => setTimeout(r, CHOKIDAR_BATCH_BOUNDARY_GAP_MS));
    }

    await auditEc.whenPredicate((events) =>
      events.some(([t]) => t === STREAM_AUDIT_EVENTS.READER_CORRUPT)
    );

    const corruptEvents = auditRec.events.filter(([t]) => t === STREAM_AUDIT_EVENTS.READER_CORRUPT);
    expect(corruptEvents.length).toBe(1);
    const cols = corruptEvents[0].slice(1) as string[];
    expect(cols.some(c => c.startsWith('path='))).toBe(true);
    expect(cols.some(c => c.startsWith('consecutive='))).toBe(true);
    expect(cols.some(c => c === 'trigger=consecutive_fail')).toBe(true);
    expect(cols.some(c => c.startsWith('recent_total='))).toBe(true);
    expect(cols.some(c => c.startsWith('recent_fail='))).toBe(true);

    const parseFailed = auditRec.events.filter(([t]) => t === STREAM_AUDIT_EVENTS.READER_PARSE_FAILED);
    expect(parseFailed.length).toBeGreaterThanOrEqual(5);

    expect(reader.isActive()).toBe(false);

    writer.write({ ts: 999, type: 'post_corrupt', text: 'should_not_arrive' });
    await new Promise(r => setTimeout(r, INVERSE_WAITFOR_WINDOW_MS)); // inverse waitFor — assert no event emitted within window
    expect(ec.events.find(e => (e as any).type === 'post_corrupt')).toBeUndefined();
  });

  it('近 RECENT_WINDOW 次 parse 中 fail 占比 > 50% 触发 STREAM_READER_CORRUPT（trigger=ratio_high）', async () => {
    writer.open();
    const auditRec = makeAudit();
    const auditEc = createEventCollector<[string, ...(string | number)[]]>();
    const wrappedAudit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        auditEc.onEvent([type, ...cols]);
        auditRec.audit.write(type, ...cols);
      },
      preview: (s: string) => auditRec.audit.preview(s),
      message: (s: string) => auditRec.audit.message(s),
      summary: (s: string) => auditRec.audit.summary(s),
    };
    reader = await makeReadyReader(fs, ec.onEvent, wrappedAudit);

    const streamAbs = nativePath.join(tempDir, STREAM_FILE);

    const okLine = (i: number) => Buffer.from(`${JSON.stringify({ ts: i, type: 'ok', i })}\n`, 'utf-8');
    const badLine = (i: number) => Buffer.from(`{bad_${i}\n`, 'utf-8');

    const pattern: ('ok' | 'bad')[] = ['ok','bad','ok','bad','ok','bad','ok','bad','bad','bad'];
    for (let i = 0; i < 10; i++) {
      nativeAppend(streamAbs, pattern[i] === 'ok' ? okLine(i) : badLine(i));
      // chokidar batch boundary: gap so appends fire as separate events (not coalesced)
      await new Promise(r => setTimeout(r, CHOKIDAR_BATCH_BOUNDARY_GAP_MS));
    }

    await auditEc.whenPredicate((events) =>
      events.some(([t]) => t === STREAM_AUDIT_EVENTS.READER_CORRUPT)
    );

    const corruptEvents = auditRec.events.filter(([t]) => t === STREAM_AUDIT_EVENTS.READER_CORRUPT);
    expect(corruptEvents.length).toBe(1);
    const cols = corruptEvents[0].slice(1) as string[];

    expect(cols.some(c => c === 'trigger=ratio_high')).toBe(true);

    const recentTotalCol = cols.find(c => c.startsWith('recent_total='))!;
    const recentFailCol = cols.find(c => c.startsWith('recent_fail='))!;
    expect(Number(recentTotalCol.split('=')[1])).toBe(10);
    expect(Number(recentFailCol.split('=')[1])).toBeGreaterThanOrEqual(6);

    expect(reader.isActive()).toBe(false);
  });
});
