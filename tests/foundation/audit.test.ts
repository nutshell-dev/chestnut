import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { FileNotFoundError } from '../../src/foundation/fs/types.js';

describe('AuditWriter', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tmpDir = await createTrackedTempDir('audit-test-');
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
    consoleErrorSpy.mockRestore();
  });

  it('writes a TSV line with timestamp, type and cols', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    writer.write('test_event', 'col1', 42);

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    const parts = content.trim().split('\t');
    expect(parts.length).toBe(5);
    expect(parts[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    expect(parts[1]).toBe('seq=1');
    expect(parts[2]).toBe('test_event');
    expect(parts[3]).toBe('col1');
    expect(parts[4]).toBe('42');
  });

  it('escapes tabs and newlines in cols', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    writer.write('escape_test', 'a\tb', 'c\nd');

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(content).toContain('a\\tb');
    expect(content).toContain('c\\nd');
  });

  it('rotates file when size exceeds maxSizeMb', () => {
    // Pre-seed audit.tsv to be larger than 1 byte
    const auditPath = path.join(tmpDir, 'audit.tsv');
    fs.writeFileSync(auditPath, 'x'.repeat(20));

    const writer = new AuditWriter(nodeFs, 'audit.tsv', 0.000001); // ~1 byte max
    writer.write('rotate_event');

    // Original should have been rotated to a .bak file
    const files = fs.readdirSync(tmpDir);
    expect(files.some(f => f.match(/audit\.tsv\.[0-9a-f]{8}\.bak/))).toBe(true);

    // New audit.tsv should contain only the new write
    const newContent = fs.readFileSync(auditPath, 'utf-8');
    expect(newContent).toContain('rotate_event');
    expect(newContent).not.toContain('x'.repeat(20));
  });

  it('silently skips rotation when file does not exist yet', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv', 1);
    writer.write('first_event');

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(content).toContain('first_event');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('calls console.error when rotation statSync throws non-FileNotFoundError', () => {
    const mockFs = {
      appendSync: vi.fn(),
      statSync: vi.fn(() => { throw new Error('disk io error'); }),
      moveSync: vi.fn(),
      syncSync: vi.fn(),
    } as unknown as NodeFileSystem;

    const writer = new AuditWriter(mockFs, 'audit.tsv', 1);
    writer.write('event');

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[AUDIT CRITICAL] rotation check failed:'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('path=audit.tsv'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=disk io error'),
    );
    // write should still attempt append after rotation failure
    expect(mockFs.appendSync).toHaveBeenCalled();
  });

  it('calls console.error when appendSync throws, and does not throw itself', () => {
    const mockFs = {
      appendSync: vi.fn(() => { throw new Error('disk full'); }),
      statSync: vi.fn(() => { throw new FileNotFoundError('not found'); }),
      moveSync: vi.fn(),
      syncSync: vi.fn(),
    } as unknown as NodeFileSystem;

    const writer = new AuditWriter(mockFs, 'audit.tsv');
    expect(() => writer.write('fail_event', 'col')).not.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[AUDIT CRITICAL] write failed:'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('type=fail_event'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=disk full'),
    );
  });

  it('continues working after a write failure', () => {
    let shouldThrow = true;
    const mockFs = {
      appendSync: vi.fn((filePath: string, content: string) => {
        if (shouldThrow) throw new Error('disk full');
        // on success, delegate to real fs for persistence verification
        nodeFs.appendSync(filePath, content);
      }),
      statSync: vi.fn(() => { throw new FileNotFoundError('not found'); }),
      moveSync: vi.fn(),
      syncSync: vi.fn(),
    } as unknown as NodeFileSystem;

    const writer = new AuditWriter(mockFs, 'audit.tsv');
    writer.write('first', 'a'); // fails
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    shouldThrow = false;
    consoleErrorSpy.mockClear();
    writer.write('second', 'b'); // succeeds

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(content).toContain('second');
    expect(content).toContain('b');
    expect(content).not.toContain('first'); // first failed, not persisted
  });

  it('escapes backslash first to prevent ambiguity', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    writer.write('backslash_test', 'a\\tb');

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    // backslash 先转，所以 \\t 应该变成 \\\\\\t，而非 \\\\t
    expect(content).toContain('a\\\\tb');
    // 确保没有歧义：不是 a\\t（看起来像转义后的 tab）
    const parts = content.trim().split('\t');
    expect(parts[parts.length - 1]).toBe('a\\\\tb');
  });

  it('escapes CR in cols', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    writer.write('cr_test', 'a\rb');

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(content).toContain('a\\rb');
  });

  it('escapes NUL in cols', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    writer.write('nul_test', 'a\0b');

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(content).toContain('a\\0b');
  });

  it('escapes ts and type columns', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    // type 含 \t，如果不过 esc，TSV 会被拆成额外列
    writer.write('type\twith\ttabs', 'col1');

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    const parts = content.trim().split('\t');
    // ts, seq, escaped-type, col1 = 4 列
    expect(parts.length).toBe(4);
    expect(parts[2]).toBe('type\\twith\\ttabs');
  });

  it('rotation uses UUID suffix not Date.now', () => {
    const auditPath = path.join(tmpDir, 'audit.tsv');
    fs.writeFileSync(auditPath, 'x'.repeat(20));

    const writer = new AuditWriter(nodeFs, 'audit.tsv', 0.000001);
    writer.write('rotate_event');

    const files = fs.readdirSync(tmpDir);
    const bakFiles = files.filter(f => f.match(/audit\.tsv\.[0-9a-f]{8}\.bak/));
    expect(bakFiles.length).toBe(1);
    // Date.now() 产生 13 位数字，不应匹配
    expect(bakFiles[0]).not.toMatch(/audit\.tsv\.\d{13}\.bak/);
  });

  it('rotation filenames are unique', () => {
    const auditPath = path.join(tmpDir, 'audit.tsv');
    fs.writeFileSync(auditPath, 'x'.repeat(20));

    const writer = new AuditWriter(nodeFs, 'audit.tsv', 0.000001);
    writer.write('rotate1'); // first rotation

    // Pre-seed new audit.tsv for second rotation
    fs.writeFileSync(auditPath, 'y'.repeat(20));
    writer.write('rotate2'); // second rotation

    const files = fs.readdirSync(tmpDir);
    const bakFiles = files.filter(f => f.endsWith('.bak'));
    expect(bakFiles.length).toBe(2);
    expect(bakFiles[0]).not.toBe(bakFiles[1]);
  });

  it('payload with CRLF produces single TSV row', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    writer.write('crlf_test', 'line1\r\nline2');

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    // 文件应只有一行（以 \n 结尾）
    const lines = content.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(1);
    // \r 和 \n 都被转义
    expect(lines[0]).toContain('line1\\r\\nline2');
  });

  it('no regression on existing tab and newline escaping', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    writer.write('regression_test', 'a\tb', 'c\nd');

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(content).toContain('a\\tb');
    expect(content).toContain('c\\nd');
  });
});
