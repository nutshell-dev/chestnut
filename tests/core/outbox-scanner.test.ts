/**
 * Outbox Scanner tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { scanClawOutboxes } from '../../src/foundation/messaging/index.js';

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

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should return null when claws directory does not exist', async () => {
    const result = await scanClawOutboxes(tempDir);
    expect(result).toBeNull();
  });

  it('should return null when all outboxes are empty', async () => {
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    const claw2Dir = path.join(tempDir, 'claws', 'claw2');
    fs.mkdirSync(path.join(claw1Dir, 'outbox', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(claw2Dir, 'outbox', 'pending'), { recursive: true });

    const result = await scanClawOutboxes(tempDir);
    expect(result).toBeNull();
  });

  it('should return structured info when claw has unread outbox messages', async () => {
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    const outboxDir = path.join(claw1Dir, 'outbox', 'pending');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'msg1.md'), 'test message');

    const result = await scanClawOutboxes(tempDir);
    expect(result).toEqual([{ clawId: 'claw1', count: 1 }]);
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

    const result = await scanClawOutboxes(tempDir);
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

    const result = await scanClawOutboxes(tempDir);
    expect(result).toEqual([{ clawId: 'claw1', count: 2 }]); // Only .md files counted
  });

  it('should return null when outbox/pending is a file (ENOTDIR error)', async () => {
    // claw1: outbox/pending is a FILE → readdir throws ENOTDIR
    // Non-ENOENT errors are now rethrown and caught by outer catch → return null
    const claw1Dir = path.join(tempDir, 'claws', 'claw1');
    fs.mkdirSync(path.join(claw1Dir, 'outbox'), { recursive: true });
    fs.writeFileSync(path.join(claw1Dir, 'outbox', 'pending'), 'i am a file not a dir');

    // claw2: valid outbox with one message
    const claw2Dir = path.join(tempDir, 'claws', 'claw2');
    fs.mkdirSync(path.join(claw2Dir, 'outbox', 'pending'), { recursive: true });
    fs.writeFileSync(path.join(claw2Dir, 'outbox', 'pending', 'msg.md'), 'test');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await scanClawOutboxes(tempDir);
    expect(result).toBeNull(); // ENOTDIR is rethrown, outer catch returns null
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should return null and write to stderr when claws dir scan throws', async () => {
    // Make clawsDir a file so readdir throws ENOTDIR → outer catch → stderr
    const clawsPath = path.join(tempDir, 'claws');
    fs.writeFileSync(clawsPath, 'i am a file not a dir');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await scanClawOutboxes(tempDir);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[OutboxScanner]'), expect.any(String));
    warnSpy.mockRestore();
  });
});
