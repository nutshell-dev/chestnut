import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AuditWriter, BatchedAuditWriter } from '../../../src/foundation/audit/index.js';
import { NoopAuditWriter } from '../../../src/core/subagent/noop-writers.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('AuditWriter sequence_number monotonic (phase 1125)', () => {
  let tmp: string;
  let auditPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1125-'));
    auditPath = path.join(tmp, 'audit.tsv');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  // 主路径
  it('每 write 产生 monotonic seq + ts col 后插 seq=<N> col', () => {
    const writer = new AuditWriter(new NodeFileSystem({ baseDir: tmp }), 'audit.tsv');
    writer.write('test_event', 'foo=bar');
    writer.write('test_event2', 'baz=qux');
    writer.write('test_event3');

    const rows = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(rows).toHaveLength(3);

    // ts col 后第 1 col 必含 seq=<N>
    expect(rows[0].split('\t')[1]).toBe('seq=1');
    expect(rows[1].split('\t')[1]).toBe('seq=2');
    expect(rows[2].split('\t')[1]).toBe('seq=3');

    // type col 位置 shift 至 col[2]
    expect(rows[0].split('\t')[2]).toBe('test_event');
    expect(rows[1].split('\t')[2]).toBe('test_event2');
    expect(rows[2].split('\t')[2]).toBe('test_event3');
  });

  // 反向 3（边界路径反向）：跨 instance seq 不共享 (per-instance monotonic)
  it('反向 3：跨 instance per-instance counter (不全局共享)', () => {
    const writerA = new AuditWriter(new NodeFileSystem({ baseDir: tmp }), 'audit.tsv');
    const writerB = new AuditWriter(new NodeFileSystem({ baseDir: tmp }), 'audit-b.tsv');
    writerA.write('a1');
    writerA.write('a2');
    writerB.write('b1');
    writerA.write('a3');

    const rowsA = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    const rowsB = fs.readFileSync(path.join(tmp, 'audit-b.tsv'), 'utf-8').trim().split('\n');

    expect(rowsA[0].split('\t')[1]).toBe('seq=1');
    expect(rowsA[1].split('\t')[1]).toBe('seq=2');
    expect(rowsA[2].split('\t')[1]).toBe('seq=3');  // writerA 第 3 row、跨 writerB 调用不影响
    expect(rowsB[0].split('\t')[1]).toBe('seq=1');  // writerB 从 1 开始
  });

  it('BatchedAuditWriter monotonic + 同 ts col 后位置', () => {
    const writer = new BatchedAuditWriter(new NodeFileSystem({ baseDir: tmp }), 'audit.tsv', { batchSize: 2, flushIntervalMs: 100000 });
    writer.write('test1');
    writer.write('test2');  // 触发 flush
    const rows = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(rows[0].split('\t')[1]).toBe('seq=1');
    expect(rows[1].split('\t')[1]).toBe('seq=2');
  });

  it('NoopAuditWriter increment seq 但无 IO', () => {
    const noop = new NoopAuditWriter();
    noop.write('a');
    noop.write('b');
    // noop 内部 seq 应 = 2、但无 audit.tsv 可读
    // 用 access private 或 cast 验证 (test-only)
    expect((noop as unknown as { seq: number }).seq).toBe(2);
  });
});
