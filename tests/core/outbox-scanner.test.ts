/**
 * Outbox Scanner tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { scanClawOutboxes } from '../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

function createTempDir(): string {
  const tempDir = fs.mkdtempSync('/tmp/clawforum-outbox-test-');
  return tempDir;
}

function cleanupTempDir(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('OutboxScanner', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;

  beforeEach(() => {
    tempDir = createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should return null when claws directory does not exist', async () => {
    const result = await scanClawOutboxes(mockFs, tempDir);
    expect(result).toBeNull();
  });

  it('should return null when all outboxes are empty', async () => {
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    const claw2Dir = path.join(tempDir, 'claws', 'claw2');
    fs.mkdirSync(path.join(claw1Dir, 'outbox', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(claw2Dir, 'outbox', 'pending'), { recursive: true });

    const result = await scanClawOutboxes(mockFs, tempDir);
    expect(result).toBeNull();
  });

  it('should return structured info when claw has unread outbox messages', async () => {
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    const outboxDir = path.join(claw1Dir, 'outbox', 'pending');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'msg1.md'), 'test message');

    const result = await scanClawOutboxes(mockFs, tempDir);
    expect(result).toEqual([{ clawId: 'claw1', count: 1, daemon: 'unknown', contract: 'none' }]);
  });

  it('should summarize multiple claws with unread messages', async () => {
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    const claw2Dir = path.join(tempDir, 'claws', 'claw2');
    const claw3Dir = path.join(tempDir, 'claws', 'claw3');

    fs.mkdirSync(path.join(claw1Dir, 'outbox', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(claw2Dir, 'outbox', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(claw3Dir, 'outbox', 'pending'), { recursive: true });

    // claw1: 2 messages
    fs.writeFileSync(path.join(claw1Dir, 'outbox', 'pending', 'msg1.md'), 'test');
    fs.writeFileSync(path.join(claw1Dir, 'outbox', 'pending', 'msg2.md'), 'test');

    // claw2: 1 message
    fs.writeFileSync(path.join(claw2Dir, 'outbox', 'pending', 'msg3.md'), 'test');

    // claw3: empty

    const result = await scanClawOutboxes(mockFs, tempDir);
    expect(result).not.toBeNull();
    expect(result!.find(i => i.clawId === 'claw1')?.count).toBe(2);
    expect(result!.find(i => i.clawId === 'claw2')?.count).toBe(1);
    expect(result!.find(i => i.clawId === 'claw3')).toBeUndefined();
  });

  it('should ignore non-.md files in outbox', async () => {
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    const outboxDir = path.join(claw1Dir, 'outbox', 'pending');
    fs.mkdirSync(outboxDir, { recursive: true });

    fs.writeFileSync(path.join(outboxDir, 'msg1.md'), 'test');
    fs.writeFileSync(path.join(outboxDir, 'msg2.md'), 'test');
    fs.writeFileSync(path.join(outboxDir, 'temp.json'), 'test');
    fs.writeFileSync(path.join(outboxDir, 'readme.txt'), 'test');

    const result = await scanClawOutboxes(mockFs, tempDir);
    expect(result).toEqual([{ clawId: 'claw1', count: 2, daemon: 'unknown', contract: 'none' }]); // Only .md files counted
  });

  it('should skip claw when outbox/pending is a file (list fails)', async () => {
    // claw1: outbox/pending is a FILE → NodeFileSystem.list wraps ENOTDIR as FS_NOT_FOUND
    // FS_NOT_FOUND is caught and silently skipped
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    fs.mkdirSync(path.join(claw1Dir, 'outbox'), { recursive: true });
    fs.writeFileSync(path.join(claw1Dir, 'outbox', 'pending'), 'i am a file not a dir');

    // claw2: valid outbox with one message
    const claw2Dir = path.join(tempDir, 'claws', 'claw2');
    fs.mkdirSync(path.join(claw2Dir, 'outbox', 'pending'), { recursive: true });
    fs.writeFileSync(path.join(claw2Dir, 'outbox', 'pending', 'msg.md'), 'test');

    const result = await scanClawOutboxes(mockFs, tempDir);
    expect(result).toEqual([{ clawId: 'claw2', count: 1, daemon: 'unknown', contract: 'none' }]);
  });

  it('should report daemon status from injected probe', async () => {
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    const claw2Dir = path.join(tempDir, 'claws', 'claw2');
    fs.mkdirSync(path.join(claw1Dir, 'outbox', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(claw2Dir, 'outbox', 'pending'), { recursive: true });
    fs.writeFileSync(path.join(claw1Dir, 'outbox', 'pending', 'a.md'), 'x');
    fs.writeFileSync(path.join(claw2Dir, 'outbox', 'pending', 'b.md'), 'x');

    const probe = { isAlive: (id: string) => id === 'claw1' };
    const result = await scanClawOutboxes(mockFs, tempDir, probe);
    expect(result!.find(i => i.clawId === 'claw1')?.daemon).toBe('running');
    expect(result!.find(i => i.clawId === 'claw2')?.daemon).toBe('stopped');
  });

  it('should detect active/paused contract from directory presence', async () => {
    const clawDirs = ['claw-active', 'claw-paused', 'claw-none'];
    for (const id of clawDirs) {
      const outbox = path.join(tempDir, 'claws', id, 'outbox', 'pending');
      fs.mkdirSync(outbox, { recursive: true });
      fs.writeFileSync(path.join(outbox, 'msg.md'), 'x');
    }
    fs.mkdirSync(path.join(tempDir, 'claws', 'claw-active', 'contract', 'active', 'c1'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'claws', 'claw-paused', 'contract', 'paused', 'c2'), { recursive: true });

    const result = await scanClawOutboxes(mockFs, tempDir);
    expect(result!.find(i => i.clawId === 'claw-active')?.contract).toBe('active');
    expect(result!.find(i => i.clawId === 'claw-paused')?.contract).toBe('paused');
    expect(result!.find(i => i.clawId === 'claw-none')?.contract).toBe('none');
  });

  it('should swallow probe errors and mark daemon unknown', async () => {
    const clawDir = path.join(tempDir, 'claws', 'claw1');
    fs.mkdirSync(path.join(clawDir, 'outbox', 'pending'), { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'outbox', 'pending', 'msg.md'), 'x');

    const probe = { isAlive: () => { throw new Error('probe failure'); } };
    const result = await scanClawOutboxes(mockFs, tempDir, probe);
    expect(result![0].daemon).toBe('unknown');
  });

  it('should return null and write to stderr when claws dir scan throws', async () => {
    // Make clawsDir a file so readdir throws ENOTDIR → outer catch → stderr
    const clawsPath = path.join(tempDir, 'claws');
    fs.writeFileSync(clawsPath, 'i am a file not a dir');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await scanClawOutboxes(mockFs, tempDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[OutboxScanner]'), expect.any(String));
    warnSpy.mockRestore();
  });
});
