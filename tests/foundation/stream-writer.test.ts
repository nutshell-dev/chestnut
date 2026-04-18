import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { StreamWriter } from '../../src/foundation/stream/index.js';
import { AUDIT_EVENTS } from '../../src/foundation/audit/events.js';
import { makeAudit } from '../helpers/audit.js';

describe('StreamWriter', () => {
  let tmpDir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-test-'));
    fs = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
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

  it('write before open triggers stream_write_dropped and does not write', () => {
    const { audit, events } = makeAudit();
    const writer = new StreamWriter(fs, audit);
    writer.write({ ts: 1, type: 'dropped' });

    const exists = fsSync.existsSync(path.join(tmpDir, 'stream.jsonl'));
    expect(exists).toBe(false);
    expect(events.some(e => e[0] === AUDIT_EVENTS.STREAM_WRITE_DROPPED)).toBe(true);
  });

  it('open archives existing stream.jsonl', () => {
    const { audit } = makeAudit();
    fsSync.writeFileSync(path.join(tmpDir, 'stream.jsonl'), '{"ts":0}\n');

    const writer = new StreamWriter(fs, audit);
    writer.open();

    const archiveDir = path.join(tmpDir, 'logs', 'stream');
    const archives = fsSync.readdirSync(archiveDir);
    expect(archives.length).toBe(1);
    expect(archives[0]).toMatch(/^stream\.\d+\.jsonl$/);
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

    expect(events.some(e => e[0] === AUDIT_EVENTS.STREAM_ARCHIVE_FAILED)).toBe(true);

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
    expect(events.some(e => e[0] === AUDIT_EVENTS.STREAM_APPEND_FAILED)).toBe(true);

    // Subsequent write should still work (appendSync mock restored on next call)
    writer.write({ ts: 2, type: 'ok' });
    const fileContent = fsSync.readFileSync(path.join(tmpDir, 'stream.jsonl'), 'utf-8');
    expect(fileContent).toContain('"type":"ok"');
  });

  it('pruneArchives single-file delete failure triggers stream_archive_prune_failed with path', () => {
    const { audit, events } = makeAudit();
    const archiveDir = path.join(tmpDir, 'logs', 'stream');
    fsSync.mkdirSync(archiveDir, { recursive: true });
    fsSync.writeFileSync(path.join(archiveDir, 'stream.1000.jsonl'), '');
    fsSync.writeFileSync(path.join(archiveDir, 'stream.2000.jsonl'), '');

    // Mock deleteSync to throw
    const originalDeleteSync = fs.deleteSync.bind(fs);
    fs.deleteSync = vi.fn((p: string) => {
      if (p.includes('stream.1000')) throw new Error('delete blocked');
      return originalDeleteSync(p);
    });

    // maxFiles: 1 means the older file (1000) should be pruned
    const writer = new StreamWriter(fs, audit, { maxFiles: 1 });
    writer.open();

    const pruneEvents = events.filter(e => e[0] === AUDIT_EVENTS.STREAM_ARCHIVE_PRUNE_FAILED);
    expect(pruneEvents.length).toBeGreaterThanOrEqual(1);
    expect(pruneEvents[0].some((col: any) => String(col).includes('path='))).toBe(true);
  });

  it('pruneArchives outer failure triggers stream_archive_prune_failed without path', () => {
    const { audit, events } = makeAudit();
    const archiveDir = path.join(tmpDir, 'logs', 'stream');
    fsSync.mkdirSync(archiveDir, { recursive: true });
    fsSync.writeFileSync(path.join(archiveDir, 'stream.1000.jsonl'), '');

    // Mock listSync to throw
    fs.listSync = vi.fn(() => { throw new Error('list blocked'); });

    const writer = new StreamWriter(fs, audit, { maxFiles: 1 });
    writer.open();

    const pruneEvents = events.filter(e => e[0] === AUDIT_EVENTS.STREAM_ARCHIVE_PRUNE_FAILED);
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
});
