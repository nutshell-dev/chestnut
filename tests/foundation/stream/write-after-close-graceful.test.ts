import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { StreamWriter } from '../../../src/foundation/stream/writer.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { STREAM_AUDIT_EVENTS } from '../../../src/foundation/stream/audit-events.js';

describe('StreamWriter write-after-close graceful (phase 1203 Issue 2)', () => {
  let tmpDir: string;
  let fs: NodeFileSystem;
  let auditWrites: unknown[][];
  let mockAudit: { write: (type: string, ...cols: unknown[]) => void };

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `stream-write-after-close-${randomUUID()}`);
    fsNative.mkdirSync(tmpDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: tmpDir });
    auditWrites = [];
    mockAudit = { write: (type, ...cols) => auditWrites.push([type, ...cols]) };
  });

  afterEach(() => {
    fsNative.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('反向 1: close() 后 write() 不 throw + emit WRITE_AFTER_CLOSE', () => {
    const writer = new StreamWriter(fs, mockAudit, { maxFiles: 10, maxDays: 30 });
    writer.open();
    writer.close();
    expect(() =>
      writer.write({ ts: Date.now(), type: 'session_boundary', reason: 'test' }),
    ).not.toThrow();
    expect(auditWrites.some(w => w[0] === STREAM_AUDIT_EVENTS.WRITE_AFTER_CLOSE)).toBe(true);
    const afterCloseAudit = auditWrites.find(w => w[0] === STREAM_AUDIT_EVENTS.WRITE_AFTER_CLOSE);
    expect(afterCloseAudit).toContainEqual('type=session_boundary');
    expect(afterCloseAudit).toContainEqual('reason=writer_closed');
  });

  it('反向 2: open() 前 write() 仍不 throw + audit', () => {
    const writer = new StreamWriter(fs, mockAudit, { maxFiles: 10, maxDays: 30 });
    // 不 open 直接 write
    expect(() =>
      writer.write({ ts: Date.now(), type: 'session_boundary', reason: 'test_pre_open' }),
    ).not.toThrow();
    expect(auditWrites.some(w => w[0] === STREAM_AUDIT_EVENTS.WRITE_AFTER_CLOSE)).toBe(true);
  });

  it('反向 3: open() → write() → close() → write() — 第 1 次 write 正常落盘、第 2 次 graceful drop', () => {
    const writer = new StreamWriter(fs, mockAudit, { maxFiles: 10, maxDays: 30 });
    writer.open();
    writer.write({ ts: 1000, type: 'turn_start', reason: 'test' });
    writer.close();
    writer.write({ ts: 2000, type: 'turn_end', reason: 'test' });

    // 验证 audit emit
    const writeAfterCloseAudits = auditWrites.filter(
      w => w[0] === STREAM_AUDIT_EVENTS.WRITE_AFTER_CLOSE,
    );
    expect(writeAfterCloseAudits).toHaveLength(1);
    expect(writeAfterCloseAudits[0]).toContainEqual('type=turn_end');

    // 验证文件内容：只有 turn_start 落盘
    const streamPath = path.join(tmpDir, 'stream.jsonl');
    const content = fsNative.readFileSync(streamPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('turn_start');
  });
});
