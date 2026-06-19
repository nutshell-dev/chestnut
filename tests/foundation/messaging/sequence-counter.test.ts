/**
 * Sequence counter tests (phase 286 Step A)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SequenceCounter, formatSeq } from '../../../src/foundation/messaging/sequence-counter.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('SequenceCounter', () => {
  let testDir: string;
  let nfs: NodeFileSystem;

  beforeEach(async () => {
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
});
