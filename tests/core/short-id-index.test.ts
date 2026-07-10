import { describe, it, expect, beforeEach } from 'vitest';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { PersistentShortIdIndex, InMemoryShortIdIndex } from '../../src/core/async-task-system/short-id-index.js';
import { makeFullTaskId, makeShortTaskId } from '../../src/core/async-task-system/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('InMemoryShortIdIndex', () => {
  it('add + has + resolve round-trip', () => {
    const index = new InMemoryShortIdIndex();
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    const shortId = makeShortTaskId('550e8400');
    expect(index.has(shortId)).toBe(false);
    index.add(shortId, fullId);
    expect(index.has(shortId)).toBe(true);
    expect(index.resolve(shortId)).toBe(fullId);
  });

  it('delete removes entry', () => {
    const index = new InMemoryShortIdIndex();
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    const shortId = makeShortTaskId('550e8400');
    index.add(shortId, fullId);
    index.delete(shortId);
    expect(index.has(shortId)).toBe(false);
    expect(index.resolve(shortId)).toBeUndefined();
  });

  it('deriveShortId returns first 8 chars of fullId', () => {
    const index = new InMemoryShortIdIndex();
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    expect(index.deriveShortId(fullId)).toBe(makeShortTaskId('550e8400'));
  });

  it('duplicate add overwrites', () => {
    const index = new InMemoryShortIdIndex();
    const shortId = makeShortTaskId('550e8400');
    index.add(shortId, makeFullTaskId('550e8400-e29b-41d4-a716-446655440000'));
    index.add(shortId, makeFullTaskId('660e8400-e29b-41d4-a716-446655440000'));
    expect(index.resolve(shortId)).toBe(makeFullTaskId('660e8400-e29b-41d4-a716-446655440000'));
  });
});

describe('PersistentShortIdIndex', () => {
  let tmpDir: string;
  let fsFactory: (baseDir: string) => NodeFileSystem;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'short-id-index-'));
    fs.mkdirSync(path.join(tmpDir, 'tasks', 'queues'), { recursive: true });
    fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
  });

  it('loads empty map when file does not exist', () => {
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.load();
    expect(index.has('550e8400')).toBe(false);
  });

  it('save persists to disk, load restores', () => {
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    const shortId = makeShortTaskId('550e8400');

    const index1 = new PersistentShortIdIndex(fsFactory(tmpDir));
    index1.add(shortId, fullId);
    index1.save();

    const index2 = new PersistentShortIdIndex(fsFactory(tmpDir));
    index2.load();
    expect(index2.has(shortId)).toBe(true);
    expect(index2.resolve(shortId)).toBe(fullId);
  });

  it('does not write disk when save is called with no changes', () => {
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.save();
    const mapPath = path.join(tmpDir, 'tasks', 'queues', 'short-id-map.json');
    expect(fs.existsSync(mapPath)).toBe(false);
  });
});
