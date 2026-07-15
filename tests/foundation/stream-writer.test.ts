/**
 * stream writer — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - stream-writer.test.ts
 *  - stream-writer-race.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsSync from 'fs';
import * as nativeFs from 'fs';
import * as path from 'path';
import * as nativePath from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { StreamWriter, STREAM_FILE } from '../../src/foundation/stream/index.js';
import { STREAM_AUDIT_EVENTS } from '../../src/foundation/stream/audit-events.js';
import { makeAudit } from '../helpers/audit.js';
import { createAuditWriter } from '../../src/foundation/audit/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

describe('stream-writer', () => {
  describe('StreamWriter', () => {
    let tmpDir: string;
    let fs: NodeFileSystem;

    beforeEach(async () => {
      tmpDir = await createTrackedTempDir('sw-test-');
      fs = new NodeFileSystem({ baseDir: tmpDir });
    });

    afterEach(async () => {
      await cleanupTempDir(tmpDir);
    });

    it('write appends a line to stream.jsonl', () => {
      const { audit } = makeAudit();
      const writer = new StreamWriter(fs, audit);
      writer.open();
      writer.write({ ts: 1, type: 'test' });

      const content = fsSync.readFileSync(path.join(tmpDir, 'stream.jsonl'), 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.type).toBe('test');
    });

    it('write before open does not throw + emits WRITE_AFTER_CLOSE audit (phase 1203)', () => {
      const { audit, events } = makeAudit();
      const writer = new StreamWriter(fs, audit);
      expect(() => writer.write({ ts: 1, type: 'dropped' })).not.toThrow();
      expect(fsSync.existsSync(path.join(tmpDir, 'stream.jsonl'))).toBe(false);
      expect(events.some(e => e[0] === 'stream_write_after_close')).toBe(true);
    });

    it('open archives existing stream.jsonl', () => {
      const { audit } = makeAudit();
      fsSync.writeFileSync(path.join(tmpDir, 'stream.jsonl'), '{"ts":0}\n');

      const writer = new StreamWriter(fs, audit);
      writer.open();

      const archiveDir = path.join(tmpDir, 'logs', 'stream');
      const archives = fsSync.readdirSync(archiveDir);
      expect(archives.length).toBe(1);
      expect(archives[0]).toMatch(/^stream\.\d+_[a-f0-9]{8}\.jsonl$/);
    });

    it('open archive failure triggers stream_archive_failed + session_boundary event', () => {
      const { audit, events } = makeAudit();
      fsSync.writeFileSync(path.join(tmpDir, 'stream.jsonl'), '{"ts":0}\n');

      // Mock moveSync to throw
      const originalMoveSync = fs.moveSync.bind(fs);
      fs.moveSync = vi.fn((from: string, to: string) => {
        if (from === 'stream.jsonl') throw new Error('move blocked');
        return originalMoveSync(from, to);
      });

      const writer = new StreamWriter(fs, audit);
      writer.open();

      expect(events.some(e => e[0] === STREAM_AUDIT_EVENTS.ARCHIVE_FAILED)).toBe(true);

      // session_boundary business event should also be written to stream.jsonl
      const content = fsSync.readFileSync(path.join(tmpDir, 'stream.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.type).toBe('session_boundary');
      expect(last.reason).toBe('archive_failed');
    });

    it('appendSync failure triggers stream_append_failed and continues', () => {
      const { audit, events } = makeAudit();
      const writer = new StreamWriter(fs, audit);
      writer.open();

      // Mock appendSync to throw once
      const originalAppendSync = fs.appendSync.bind(fs);
      let throwCount = 0;
      fs.appendSync = vi.fn((filePath: string, content: string) => {
        if (filePath === 'stream.jsonl' && throwCount < 1) {
          throwCount++;
          throw new Error('disk full');
        }
        return originalAppendSync(filePath, content);
      });

      writer.write({ ts: 1, type: 'fail' });
      expect(events.some(e => e[0] === STREAM_AUDIT_EVENTS.APPEND_FAILED)).toBe(true);

      const failEvent = events.find(e => e[0] === STREAM_AUDIT_EVENTS.APPEND_FAILED);
      expect(failEvent?.some((col: unknown) => String(col).startsWith('type='))).toBe(true);
      expect(failEvent?.some((col: unknown) => String(col).startsWith('body='))).toBe(true);

      // Subsequent write should still work (appendSync mock restored on next call)
      writer.write({ ts: 2, type: 'ok' });
      const fileContent = fsSync.readFileSync(path.join(tmpDir, 'stream.jsonl'), 'utf-8');
      expect(fileContent).toContain('"type":"ok"');
    });

    it('pruneArchives single-file delete failure triggers stream_archive_prune_failed with path', () => {
      const { audit, events } = makeAudit();
      const archiveDir = path.join(tmpDir, 'logs', 'stream');
      fsSync.mkdirSync(archiveDir, { recursive: true });
      // phase 324 H8: 归档名形 stream.<ts>_<uuid>.jsonl（writer.ts:55）。
      fsSync.writeFileSync(path.join(archiveDir, 'stream.1000_abcdef.jsonl'), '');
      fsSync.writeFileSync(path.join(archiveDir, 'stream.2000_fedcba.jsonl'), '');

      // Mock deleteSync to throw
      const originalDeleteSync = fs.deleteSync.bind(fs);
      fs.deleteSync = vi.fn((p: string) => {
        if (p.includes('stream.1000')) throw new Error('delete blocked');
        return originalDeleteSync(p);
      });

      // maxFiles: 1 means the older file (1000) should be pruned
      const writer = new StreamWriter(fs, audit, { maxFiles: 1 });
      writer.open();

      const pruneEvents = events.filter(e => e[0] === STREAM_AUDIT_EVENTS.ARCHIVE_PRUNE_FAILED);
      expect(pruneEvents.length).toBeGreaterThanOrEqual(1);
      expect(pruneEvents[0].some((col: any) => String(col).includes('path='))).toBe(true);
    });

    it('pruneArchives outer failure triggers stream_archive_prune_failed without path', () => {
      const { audit, events } = makeAudit();
      const archiveDir = path.join(tmpDir, 'logs', 'stream');
      fsSync.mkdirSync(archiveDir, { recursive: true });
      fsSync.writeFileSync(path.join(archiveDir, 'stream.1000_abcdef.jsonl'), '');

      // Mock listSync to throw
      fs.listSync = vi.fn(() => { throw new Error('list blocked'); });

      const writer = new StreamWriter(fs, audit, { maxFiles: 1 });
      writer.open();

      const pruneEvents = events.filter(e => e[0] === STREAM_AUDIT_EVENTS.ARCHIVE_PRUNE_FAILED);
      expect(pruneEvents.length).toBeGreaterThanOrEqual(1);
      // outer failure should not have path column
      const noPathEvent = pruneEvents.find(e => !e.some(col => String(col).startsWith('path=')));
      expect(noPathEvent).toBeDefined();
    });

    it('close is idempotent', () => {
      const { audit } = makeAudit();
      const writer = new StreamWriter(fs, audit);
      writer.open();
      writer.close();
      writer.close();
      expect(() => writer.close()).not.toThrow();
    });

    it('open archives then writeAtomic empty emits WRITER_OPEN_CREATED_EMPTY (phase 1011 D.4 invariant doc)', () => {
      const { audit, events } = makeAudit();
      fsSync.writeFileSync(path.join(tmpDir, 'stream.jsonl'), '{"ts":0}\n');

      const writer = new StreamWriter(fs, audit);
      writer.open();

      expect(events.some(e => e[0] === STREAM_AUDIT_EVENTS.WRITER_OPEN_CREATED_EMPTY)).toBe(true);

      // session boundary: archive exists + new empty file exists
      const archiveDir = path.join(tmpDir, 'logs', 'stream');
      const archives = fsSync.readdirSync(archiveDir);
      expect(archives.length).toBe(1);
      expect(fsSync.existsSync(path.join(tmpDir, 'stream.jsonl'))).toBe(true);
    });
  });
});

describe('stream-writer-race', () => {
  describe('StreamWriter open() race-safe (phase 1120)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    let audit: AuditLog;
    let auditPath: string;
    let streamPath: string;

    beforeEach(async () => {
      tempDir = await createTrackedTempDir('stream-race-');
      fs = new NodeFileSystem({ baseDir: tempDir });
      auditPath = nativePath.join(tempDir, 'audit.tsv');
      audit = createAuditWriter(fs, auditPath);
      streamPath = nativePath.join(tempDir, STREAM_FILE);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('normal path: exclusive create empty file + emit WRITER_OPEN_CREATED_EMPTY', () => {
      const w = new StreamWriter(fs, audit);
      w.open();
      expect(nativeFs.existsSync(streamPath)).toBe(true);
      expect(nativeFs.readFileSync(streamPath, 'utf-8')).toBe('');
      const auditContent = nativeFs.readFileSync(auditPath, 'utf-8');
      expect(auditContent).toMatch(/stream_writer_open_created_empty/);
      expect(auditContent).not.toMatch(/stream_writer_open_preserved_raced/);
    });

    it('race won path: pre-create with CLI content → exclusive create EEXIST → preserve + emit WRITER_OPEN_PRESERVED_RACED', () => {
      // 1) 先让第一次 open() 完成 archive（清场）
      const w1 = new StreamWriter(fs, audit);
      w1.open();

      // 2) 模拟 CLI cross-process append: 在 daemon 新 session open() 前写入
      const cliLine = JSON.stringify({ ts: 100, type: 'user_notify', subtype: 'contract_created', contractId: 'c-001' }) + '\n';
      nativeFs.writeFileSync(streamPath, cliLine);

      // 3) 新 StreamWriter，mock existsSync 跳过 archive 阶段，直接触发 create EEXIST
      const fsSpy = new NodeFileSystem({ baseDir: tempDir });
      vi.spyOn(fsSpy, 'existsSync').mockReturnValue(false);

      const w2 = new StreamWriter(fsSpy, audit);
      w2.open();

      // CLI 写完整保留（不被覆盖）
      expect(nativeFs.readFileSync(streamPath, 'utf-8')).toBe(cliLine);

      // audit emit WRITER_OPEN_PRESERVED_RACED
      const auditContent = nativeFs.readFileSync(auditPath, 'utf-8');
      expect(auditContent).toMatch(/stream_writer_open_preserved_raced/);
      expect(auditContent).toMatch(/cli_cross_process_append_race_won/);
      expect(auditContent).toMatch(new RegExp(`bytes=${cliLine.length}`));
    });

    it('race won path: subsequent write() appends after CLI content', () => {
      // 1) 先让第一次 open() 完成 archive（清场）
      const w1 = new StreamWriter(fs, audit);
      w1.open();

      // 2) 模拟 CLI cross-process append
      const cliLine = JSON.stringify({ ts: 100, type: 'user_notify' }) + '\n';
      nativeFs.writeFileSync(streamPath, cliLine);

      // 3) 新 StreamWriter，mock existsSync 跳过 archive
      const fsSpy = new NodeFileSystem({ baseDir: tempDir });
      vi.spyOn(fsSpy, 'existsSync').mockReturnValue(false);

      const w2 = new StreamWriter(fsSpy, audit);
      w2.open();
      w2.write({ ts: 200, type: 'daemon_evt' });

      const content = nativeFs.readFileSync(streamPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ ts: 100, type: 'user_notify' });
      expect(JSON.parse(lines[1])).toMatchObject({ ts: 200, type: 'daemon_evt' });
    });
  });
});
