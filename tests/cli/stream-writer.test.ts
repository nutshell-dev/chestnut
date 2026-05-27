/**
 * StreamWriter tests — via FileSystem
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StreamWriter } from '../../src/foundation/stream/writer.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { makeAudit } from '../helpers/audit.js';

describe('StreamWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('write() before open does not throw + emits WRITE_AFTER_CLOSE audit (phase 1203)', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const { audit, events } = makeAudit();
    const sw = new StreamWriter(fs, audit);
    expect(() => sw.write({ ts: 1, type: 'test' })).not.toThrow();
    expect(events.some(e => e[0] === 'stream_write_after_close')).toBe(true);
  });

  it('write() when appendSync throws audits and does not propagate', () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const { audit, events } = makeAudit();
    const sw = new StreamWriter(fs, audit);
    sw.open();

    vi.spyOn(NodeFileSystem.prototype, 'appendSync').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => sw.write({ ts: 1, type: 'test' })).not.toThrow();
    expect(events.some(e => e[0] === 'stream_append_failed')).toBe(true);

    const failEvent = events.find(e => e[0] === 'stream_append_failed');
    expect(failEvent?.some((col: unknown) => String(col).startsWith('type='))).toBe(true);
    expect(failEvent?.some((col: unknown) => String(col).startsWith('body='))).toBe(true);

    vi.restoreAllMocks();
  });

  it('open + write × 2 + close produces valid JSON lines', async () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const sw = new StreamWriter(fs, makeAudit().audit);
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
