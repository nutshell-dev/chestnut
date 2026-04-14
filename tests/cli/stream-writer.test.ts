/**
 * StreamWriter tests — via IFileSystem
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StreamWriter } from '../../src/foundation/stream/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { IFileSystem } from '../../src/foundation/fs/types.js';

describe('StreamWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('write() before open is a no-op and does not throw', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
    const sw = new StreamWriter(fs);
    expect(() => sw.write({ ts: 1, type: 'test' })).not.toThrow();
  });

  it('write() when appendSync throws logs to stderr and does not propagate', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
    const sw = new StreamWriter(fs);
    sw.open();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(NodeFileSystem.prototype, 'appendSync').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => sw.write({ ts: 1, type: 'test' })).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[StreamWriter]'),
      expect.anything(),
    );

    vi.restoreAllMocks();
  });

  it('open + write × 2 + close produces valid JSON lines', async () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
    const sw = new StreamWriter(fs);
    sw.open();
    sw.write({ ts: 1000, type: 'turn_start' });
    sw.write({ ts: 2000, type: 'turn_end' });
    sw.close();

    const raw = await fsp.readFile(path.join(tmpDir, 'stream.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ts: 1000, type: 'turn_start' });
    expect(lines[1]).toMatchObject({ ts: 2000, type: 'turn_end' });
  });
});
