import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { FileNotFoundError } from '../../src/types/errors.js';

describe('AuditWriter', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
    nodeFs = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
    consoleErrorSpy.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a TSV line with timestamp, type and cols', () => {
    const writer = new AuditWriter(nodeFs, 'audit.tsv');
    writer.write('test_event', 'col1', 42);

    const content = fs.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    const parts = content.trim().split('\t');
    expect(parts.length).toBe(4);
    expect(parts[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    expect(parts[1]).toBe('test_event');
    expect(parts[2]).toBe('col1');
    expect(parts[3]).toBe('42');
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
    expect(files.some(f => f.match(/audit\.tsv\.\d+\.bak/))).toBe(true);

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
});
