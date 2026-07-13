/**
 * Sequence counter tests (phase 286 Step A)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SequenceCounter, formatSeq, getSharedSequenceCounter } from '../../../src/foundation/messaging/sequence-counter.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

describe('SequenceCounter', () => {
  let testDir: string;
  let nfs: NodeFileSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `seq-counter-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('starts at 1 when no seq file exists', async () => {
    const counter = new SequenceCounter(nfs, testDir);
    expect(await counter.next()).toBe(1);
  });

  it('increments monotonically', async () => {
    const counter = new SequenceCounter(nfs, testDir);
    expect(await counter.next()).toBe(1);
    expect(await counter.next()).toBe(2);
    expect(await counter.next()).toBe(3);
  });

  it('sync nextSync increments monotonically', () => {
    const counter = new SequenceCounter(nfs, testDir);
    expect(counter.nextSync()).toBe(1);
    expect(counter.nextSync()).toBe(2);
  });

  it('persists across counter instances', async () => {
    const c1 = new SequenceCounter(nfs, testDir);
    await c1.next();
    await c1.next();

    const c2 = new SequenceCounter(nfs, testDir);
    expect(await c2.next()).toBe(3);
  });

  it('recovers from corrupted seq file', async () => {
    await fs.writeFile(path.join(testDir, '.next-msg-seq'), 'not-a-number', 'utf-8');
    const counter = new SequenceCounter(nfs, testDir);
    expect(await counter.next()).toBe(1);
  });

  it('formatSeq pads to 10 digits', () => {
    expect(formatSeq(1)).toBe('0000000001');
    expect(formatSeq(1234567890)).toBe('1234567890');
  });

  it('shared counter serializes concurrent increments across instances', async () => {
    const c1 = getSharedSequenceCounter(nfs, testDir);
    const c2 = getSharedSequenceCounter(nfs, testDir);
    const [s1, s2] = await Promise.all([c1.next(), c2.next()]);
    expect(s1).not.toBe(s2);
    expect(Math.abs(s1 - s2)).toBe(1);
  });

  it('phase 934: next() recovers from a single read failure and continues incrementing', async () => {
    const underlying = new NodeFileSystem({ baseDir: testDir });
    let firstRead = true;
    const mockFs = {
      read: vi.fn(async (p: string) => {
        if (firstRead) {
          firstRead = false;
          const err = new Error('EIO') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return underlying.read(p);
      }),
      writeAtomic: vi.fn((p: string, content: string) => underlying.writeAtomic(p, content)),
    } as unknown as FileSystem;

    const counter = new SequenceCounter(mockFs, testDir);
    await expect(counter.next()).rejects.toThrow('EIO');
    expect(await counter.next()).toBe(1);
    expect(await counter.next()).toBe(2);
  });

  it('phase 934: a previous rejection does not poison the next call', async () => {
    let shouldFail = true;
    const mockFs = {
      read: vi.fn(async () => {
        if (shouldFail) {
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
      writeAtomic: vi.fn(async () => {}),
    } as unknown as FileSystem;

    const counter = new SequenceCounter(mockFs, testDir);
    await expect(counter.next()).rejects.toThrow('EACCES');
    shouldFail = false;
    expect(await counter.next()).toBe(1);
  });
});
