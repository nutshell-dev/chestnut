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

  it('canonicalShortId returns original shortId for legacy tasks', () => {
    const index = new InMemoryShortIdIndex();
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    const legacyShortId = makeShortTaskId('abcdef12');
    // legacy: shortId ≠ deriveShortId(fullId) = "550e8400"
    index.add(legacyShortId, fullId);
    expect(index.canonicalShortId(fullId)).toBe(legacyShortId);
    expect(index.canonicalShortId(fullId)).not.toBe(index.deriveShortId(fullId));
  });

  it('canonicalShortId returns undefined for unregistered fullId', () => {
    const index = new InMemoryShortIdIndex();
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    expect(index.canonicalShortId(fullId)).toBeUndefined();
  });

  it('throws when two different shortIds map to the same fullId', () => {
    const index = new InMemoryShortIdIndex();
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    index.add(makeShortTaskId('abcdef12'), fullId);
    expect(() => index.add(makeShortTaskId('34567890'), fullId)).toThrow(/collision/i);
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

  it('reverseResolve finds canonical shortId for legacy mapping', () => {
    const index = new InMemoryShortIdIndex();
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    const canonicalShortId = makeShortTaskId('abcdef12');
    // Legacy: shortId (abcdef12) ≠ deriveShortId(fullId) (550e8400)
    index.add(canonicalShortId, fullId);
    expect(index.reverseResolve(fullId)).toBe(canonicalShortId);
    expect(index.reverseResolve(fullId)).not.toBe(index.deriveShortId(fullId));
  });

  it('add throws on conflict with existing different fullId during migration', () => {
    const index = new InMemoryShortIdIndex();
    const shortId = makeShortTaskId('abcdef12');
    index.add(shortId, makeFullTaskId('550e8400-e29b-41d4-a716-446655440000'));
    // Migration encounters same shortId pointing to different fullId
    expect(() =>
      index.add(shortId, makeFullTaskId('660e8400-e29b-41d4-a716-446655440000'))
    ).toThrow(/collision/i);
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

  it('rebuildFromDisk skips tasks with invalid shortId format', () => {
    const fullId = '550e8400-e29b-41d4-a716-446655440000';
    const runningDir = path.join(tmpDir, 'tasks', 'queues', 'running');
    fs.mkdirSync(runningDir, { recursive: true });
    fs.writeFileSync(path.join(runningDir, `${fullId}.json`), JSON.stringify({
      kind: 'tool', id: fullId, shortId: '!!!', toolName: 'exec', args: { command: 'echo hi' },
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

    expect(index.has('!!!')).toBe(false);
    const failedEvent = events.find(e => e.event === 'short_id_index_load_failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload.context).toBe('rebuild_skip_invalid');
    expect(failedEvent?.payload.storedShortId).toBe('!!!');
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

  it('sets needsRebuild when index file does not exist', () => {
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    // 不创建 short-id-map.json
    index.load();
    expect(index.needsRebuild).toBe(true);
  });

  it('rebuildFromDisk preserves old 8-char task.id as shortId', () => {
    const runningDir = path.join(tmpDir, 'tasks', 'queues', 'running');
    fs.mkdirSync(runningDir, { recursive: true });
    // 旧格式：文件名和 task.id 都是 8 位
    fs.writeFileSync(path.join(runningDir, 'abcdef12.json'), JSON.stringify({
      kind: 'tool', id: 'abcdef12', toolName: 'exec',
      args: { command: 'echo hi' },
      parentClawDir: '/t', parentClawId: 'p',
      createdAt: new Date().toISOString(),
      isIdempotent: false, maxRetries: 2, retryCount: 0,
    }));

    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.rebuildFromDisk({
      existsSync: (p) => fs.existsSync(path.join(tmpDir, p)),
      listSync: (p, opts) => fs.readdirSync(path.join(tmpDir, p), { withFileTypes: true })
        .filter(d => !opts?.includeDirs || !d.isDirectory()).map(d => ({ name: d.name })),
      readSync: (p) => fs.readFileSync(path.join(tmpDir, p), 'utf-8'),
    });

    // shortId 应为原 8 位 ID，不是随机 UUID 的前 8 位
    expect(index.has('abcdef12')).toBe(true);
    const resolved = index.resolve('abcdef12');
    expect(resolved).toBeDefined();
    expect(resolved!.length).toBe(36); // fullId 是 UUID
    expect(index.deriveShortId(resolved!)).not.toBe('abcdef12'); // fullId 前 8 位 ≠ 原 shortId
  });

  it('rebuildFromDisk is idempotent across two runs after migration writes shortId', () => {
    const runningDir = path.join(tmpDir, 'tasks', 'queues', 'running');
    fs.mkdirSync(runningDir, { recursive: true });
    // Legacy task: 8-char filename + 8-char content id, no shortId
    fs.writeFileSync(path.join(runningDir, 'abcdef12.json'), JSON.stringify({
      kind: 'tool', id: 'abcdef12', toolName: 'exec',
      args: { command: 'echo hi' },
      parentClawDir: '/t', parentClawId: 'p',
      createdAt: new Date().toISOString(),
      isIdempotent: false, maxRetries: 2, retryCount: 0,
    }));

    const makeFs = () => ({
      existsSync: (p: string) => fs.existsSync(path.join(tmpDir, p)),
      listSync: (p: string, opts?: { includeDirs?: boolean }) =>
        fs.readdirSync(path.join(tmpDir, p), { withFileTypes: true })
          .filter(d => !opts?.includeDirs || !d.isDirectory()).map(d => ({ name: d.name })),
      readSync: (p: string) => fs.readFileSync(path.join(tmpDir, p), 'utf-8'),
    });

    // First rebuild
    const index1 = new PersistentShortIdIndex(fsFactory(tmpDir));
    index1.rebuildFromDisk(makeFs());
    const fullId1 = index1.resolve('abcdef12');
    expect(fullId1).toBeDefined();

    // Simulate migration move (movePendingToRunning): rename to UUID filename
    // AND migrate JSON content to persist id + shortId (Phase 867)
    const legacyPath = path.join(runningDir, 'abcdef12.json');
    const migratedPath = path.join(runningDir, `${fullId1}.json`);
    fs.renameSync(legacyPath, migratedPath);
    const migratedTask = JSON.parse(fs.readFileSync(migratedPath, 'utf-8'));
    migratedTask.id = fullId1;
    migratedTask.shortId = 'abcdef12';
    fs.writeFileSync(migratedPath, JSON.stringify(migratedTask));

    // Second rebuild — explicit shortId field gives same mapping
    const index2 = new PersistentShortIdIndex(fsFactory(tmpDir));
    index2.rebuildFromDisk(makeFs());
    const fullId2 = index2.resolve('abcdef12');

    expect(fullId2).toBe(fullId1);
  });

  it('rebuildFromDisk uses explicit shortId field when present', () => {
    const runningDir = path.join(tmpDir, 'tasks', 'queues', 'running');
    fs.mkdirSync(runningDir, { recursive: true });
    // Phase 867 format: id is UUID, shortId is explicit 8-char (different from deriveShortId(fullId))
    const fullId = '550e8400-e29b-41d4-a716-446655440000';
    const explicitShortId = 'abcdef12'; // different from deriveShortId(fullId) = '550e8400'
    fs.writeFileSync(path.join(runningDir, `${fullId}.json`), JSON.stringify({
      kind: 'tool', id: fullId, shortId: explicitShortId, toolName: 'exec',
      args: { command: 'echo hi' },
      parentClawDir: '/t', parentClawId: 'p',
      createdAt: new Date().toISOString(),
      isIdempotent: false, maxRetries: 2, retryCount: 0,
    }));

    const makeFs = () => ({
      existsSync: (p: string) => fs.existsSync(path.join(tmpDir, p)),
      listSync: (p: string, opts?: { includeDirs?: boolean }) =>
        fs.readdirSync(path.join(tmpDir, p), { withFileTypes: true })
          .filter(d => !opts?.includeDirs || !d.isDirectory()).map(d => ({ name: d.name })),
      readSync: (p: string) => fs.readFileSync(path.join(tmpDir, p), 'utf-8'),
    });

    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.rebuildFromDisk(makeFs());

    expect(index.has(explicitShortId)).toBe(true);
    expect(index.resolve(explicitShortId)).toBe(makeFullTaskId(fullId));
    // Should NOT use derived shortId '550e8400'
    expect(index.has('550e8400')).toBe(false);
  });

  it('full legacy transition: 8-char task → move → migrate → rebuild', () => {
    const runningDir = path.join(tmpDir, 'tasks', 'queues', 'running');
    fs.mkdirSync(runningDir, { recursive: true });
    // 1. Create legacy task (8-char filename + 8-char id, no shortId)
    const shortId = 'abcdef12';
    fs.writeFileSync(path.join(runningDir, `${shortId}.json`), JSON.stringify({
      kind: 'tool', id: shortId, toolName: 'exec',
      args: { command: 'echo hi' },
      parentClawDir: '/t', parentClawId: 'p',
      createdAt: new Date().toISOString(),
      isIdempotent: false, maxRetries: 2, retryCount: 0,
    }));

    const makeFs = () => ({
      existsSync: (p: string) => fs.existsSync(path.join(tmpDir, p)),
      listSync: (p: string, opts?: { includeDirs?: boolean }) =>
        fs.readdirSync(path.join(tmpDir, p), { withFileTypes: true })
          .filter(d => !opts?.includeDirs || !d.isDirectory()).map(d => ({ name: d.name })),
      readSync: (p: string) => fs.readFileSync(path.join(tmpDir, p), 'utf-8'),
    });

    // 2. rebuildFromDisk → register in index
    const index1 = new PersistentShortIdIndex(fsFactory(tmpDir));
    index1.rebuildFromDisk(makeFs());
    const fullId = index1.resolve(shortId);
    expect(fullId).toBeDefined();
    expect(fullId!.length).toBe(36);

    // 3. Simulate move: rename file to UUID name, run migration (write id + shortId)
    const legacyPath = path.join(runningDir, `${shortId}.json`);
    const migratedPath = path.join(runningDir, `${fullId}.json`);
    fs.renameSync(legacyPath, migratedPath);
    const migratedTask = JSON.parse(fs.readFileSync(migratedPath, 'utf-8'));
    migratedTask.id = fullId;
    migratedTask.shortId = shortId;
    fs.writeFileSync(migratedPath, JSON.stringify(migratedTask));

    // 4. Persist and then delete index file to force a clean rebuild
    index1.save();
    const indexPath = path.join(tmpDir, 'tasks', 'queues', 'short-id-map.json');
    fs.unlinkSync(indexPath);

    // 5. rebuildFromDisk again → verify same shortId → same fullId
    const index2 = new PersistentShortIdIndex(fsFactory(tmpDir));
    index2.rebuildFromDisk(makeFs());
    expect(index2.resolve(shortId)).toBe(fullId);
  });

  it('load rejects null index → needsRebuild', () => {
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'queues', 'short-id-map.json'), 'null');
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.load();
    expect(index.needsRebuild).toBe(true);
  });

  it('load rejects array index → needsRebuild', () => {
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'queues', 'short-id-map.json'), '[]');
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.load();
    expect(index.needsRebuild).toBe(true);
  });

  it('load rejects invalid UUID value → needsRebuild', () => {
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'queues', 'short-id-map.json'),
      JSON.stringify({ abcdef12: 'not-a-uuid' }));
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.load();
    expect(index.needsRebuild).toBe(true);
  });

  it('load rejects length-36 but non-UUID value → needsRebuild', () => {
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'queues', 'short-id-map.json'),
      JSON.stringify({ abcdef12: 'not-a-uuid-but-length-36-characters' }));
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.load();
    expect(index.needsRebuild).toBe(true);
  });

  it('load rejects invalid shortId key → needsRebuild', () => {
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'queues', 'short-id-map.json'),
      JSON.stringify({ badkey: '550e8400-e29b-41d4-a716-446655440000' }));
    const index = new PersistentShortIdIndex(fsFactory(tmpDir));
    index.load();
    expect(index.needsRebuild).toBe(true);
  });
});
