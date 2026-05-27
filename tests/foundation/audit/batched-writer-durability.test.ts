import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { BatchedAuditWriter } from '../../../src/foundation/audit/batched-writer.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('BatchedAuditWriter durability (phase 1168 α-4a)', () => {
  let tempDir: string;
  let auditPath: string;
  let nodeFs: NodeFileSystem;
  let writer: BatchedAuditWriter;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = path.join(tmpdir(), `audit-durability-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    auditPath = path.join(tempDir, 'audit.tsv');
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    writer?.dispose();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('反向 1：flush 后磁盘文件含已 flush 行（batchSize trigger auto-flush）', async () => {
    writer = new BatchedAuditWriter(nodeFs, 'audit.tsv', { batchSize: 5, flushIntervalMs: 60_000 });

    for (let i = 1; i <= 5; i++) {
      writer.write('test_event', `seq=${i}`);
    }
    // batchSize=5 triggers auto-flush on 5th write

    const content = await fs.readFile(auditPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(5);
    for (let i = 1; i <= 5; i++) {
      expect(lines.some(l => l.includes(`seq=${i}`))).toBe(true);
    }
  });

  it('反向 2：未 flush buffer 行（< batchSize）直接读文件验证 0 行（合约边界）', async () => {
    writer = new BatchedAuditWriter(nodeFs, 'audit.tsv', { batchSize: 50, flushIntervalMs: 60_000 });

    for (let i = 1; i <= 10; i++) {
      writer.write('unflushed_event', `seq=${i}`);
    }
    // buffer=10 < batchSize=50, no auto-flush

    // Simulate "process kill" by reading file without dispose/flush
    const exists = await fs.access(auditPath).then(() => true).catch(() => false);
    if (exists) {
      const content = await fs.readFile(auditPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(0);
    }
    // If file doesn't exist yet, that's also 0 lines — contract boundary verified
    expect((writer as any).buffer.length).toBe(10);
  });

  it('反向 3：dispose() 末 flush + fsync、全持久', async () => {
    writer = new BatchedAuditWriter(nodeFs, 'audit.tsv', { batchSize: 50, flushIntervalMs: 60_000 });

    for (let i = 1; i <= 7; i++) {
      writer.write('dispose_event', `seq=${i}`);
    }

    writer.dispose();

    const content = await fs.readFile(auditPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(7);
    for (let i = 1; i <= 7; i++) {
      expect(lines.some(l => l.includes(`seq=${i}`))).toBe(true);
    }
  });
});
