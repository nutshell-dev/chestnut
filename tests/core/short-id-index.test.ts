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

  it('add throws on collision with different fullId', () => {
    const index = new InMemoryShortIdIndex();
    const shortId = makeShortTaskId('550e8400');
    index.add(shortId, makeFullTaskId('550e8400-e29b-41d4-a716-446655440000'));
    expect(() =>
      index.add(shortId, makeFullTaskId('660e8400-e29b-41d4-a716-446655440000'))
    ).toThrow(/collision/i);
    // 原始映射不变
    expect(index.resolve(shortId)).toBe(makeFullTaskId('550e8400-e29b-41d4-a716-446655440000'));
  });

  it('add is idempotent for same fullId', () => {
    const index = new InMemoryShortIdIndex();
    const shortId = makeShortTaskId('550e8400');
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    index.add(shortId, fullId);
    index.add(shortId, fullId); // 不应抛错
    expect(index.resolve(shortId)).toBe(fullId);
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

  it('rebuildFromDisk restores index from UUID task files', () => {
    const fullId = '550e8400-e29b-41d4-a716-446655440000';
    const runningDir = path.join(tmpDir, 'tasks', 'queues', 'running');
    fs.mkdirSync(runningDir, { recursive: true });
    fs.writeFileSync(path.join(runningDir, `${fullId}.json`), JSON.stringify({
      kind: 'tool', id: fullId, toolName: 'exec', args: { command: 'echo hi' },
      parentClawDir: '/t', parentClawId: 'p', createdAt: new Date().toISOString(),
      isIdempotent: false, maxRetries: 2, retryCount: 0,
    }));

    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.rebuildFromDisk(
      { existsSync: (p) => fs.existsSync(path.join(tmpDir, p)),
        listSync: (p, opts) => fs.readdirSync(path.join(tmpDir, p), { withFileTypes: true })
          .filter(d => opts?.includeDirs || !d.isDirectory()).map(d => ({ name: d.name })),
        readSync: (p) => fs.readFileSync(path.join(tmpDir, p), 'utf-8') },
    );

    const shortId = index.deriveShortId(makeFullTaskId(fullId));
    expect(index.has(shortId)).toBe(true);
    expect(index.resolve(shortId)).toBe(makeFullTaskId(fullId));
  });

  it('rebuildFromDisk reports collisions', () => {
    const fullId1 = '550e8400-e29b-41d4-a716-446655440000';
    const fullId2 = '550e8400-e29b-41d4-a716-446655441111';
    const runningDir = path.join(tmpDir, 'tasks', 'queues', 'running');
    fs.mkdirSync(runningDir, { recursive: true });
    fs.writeFileSync(path.join(runningDir, `${fullId1}.json`), JSON.stringify({
      kind: 'tool', id: fullId1, toolName: 'exec', args: { command: 'echo hi' },
      parentClawDir: '/t', parentClawId: 'p', createdAt: new Date().toISOString(),
      isIdempotent: false, maxRetries: 2, retryCount: 0,
    }));
    fs.writeFileSync(path.join(runningDir, `${fullId2}.json`), JSON.stringify({
      kind: 'tool', id: fullId2, toolName: 'exec', args: { command: 'echo hi' },
      parentClawDir: '/t', parentClawId: 'p', createdAt: new Date().toISOString(),
      isIdempotent: false, maxRetries: 2, retryCount: 0,
    }));

    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.rebuildFromDisk(
      { existsSync: (p) => fs.existsSync(path.join(tmpDir, p)),
        listSync: (p, opts) => fs.readdirSync(path.join(tmpDir, p), { withFileTypes: true })
          .filter(d => opts?.includeDirs || !d.isDirectory()).map(d => ({ name: d.name })),
        readSync: (p) => fs.readFileSync(path.join(tmpDir, p), 'utf-8') },
      { write: (event, payload) => events.push({ event, payload }) },
    );

    const shortId = index.deriveShortId(makeFullTaskId(fullId1));
    expect(index.has(shortId)).toBe(true);
    expect(index.resolve(shortId)).toBe(makeFullTaskId(fullId1));

    const collisionEvent = events.find(e => e.event === 'short_id_collision');
    expect(collisionEvent).toBeDefined();
    const collisions = collisionEvent?.payload.collisions as Array<{ shortId: string; existingFullId: string; conflictingFullId: string }>;
    expect(collisions.length).toBe(1);
    expect(collisions[0].shortId).toBe(shortId);
    expect(collisions[0].existingFullId).toBe(makeFullTaskId(fullId1));
    expect(collisions[0].conflictingFullId).toBe(makeFullTaskId(fullId2));

    const rebuiltEvent = events.find(e => e.event === 'short_id_index_rebuilt');
    expect(rebuiltEvent).toBeDefined();
    expect(rebuiltEvent?.payload.entryCount).toBe(1);
    expect(rebuiltEvent?.payload.collisionCount).toBe(1);
  });
});
