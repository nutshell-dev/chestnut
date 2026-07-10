/**
 * @module L4.AsyncTaskSystem.ShortIdIndex
 *
 * Phase 849: shortId ↔ fullId mapping index persisted at
 * tasks/queues/short-id-map.json.
 * Phase 854: load() distinguishes ENOENT from corruption/IO errors, rebuilds
 * from disk when needed, and add() rejects collisions.
 */

import { isFileNotFound } from '../../foundation/fs/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { FullTaskId, ShortTaskId, ShortIdIndex } from './types.js';
import { makeFullTaskId, makeShortTaskId } from './types.js';
import { newUuid } from '../../foundation/node-utils/index.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
} from './dirs.js';

const INDEX_PATH = 'tasks/queues/short-id-map.json';

export interface ShortIdMap {
  [shortId: string]: string; // shortId → full UUID string
}

export interface ShortIdIndexAuditWriter {
  write(event: string, payload: Record<string, unknown>): void;
}

/** In-memory ShortIdIndex for tests or lightweight scenarios. */
export class InMemoryShortIdIndex implements ShortIdIndex {
  readonly needsRebuild = false;
  private map = new Map<string, FullTaskId>();

  load(_auditWriter?: ShortIdIndexAuditWriter): void { /* no-op */ }
  save(): void { /* no-op */ }
  has(shortId: string): boolean { return this.map.has(shortId); }
  add(shortId: ShortTaskId, fullId: FullTaskId, auditWriter?: ShortIdIndexAuditWriter): void {
    const existing = this.map.get(shortId);
    if (existing && existing !== fullId) {
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_COLLISION, {
        shortId,
        existingFullId: existing,
        conflictingFullId: fullId,
      });
      throw new Error(`ShortId collision: "${shortId}" already maps to "${existing}", cannot add "${fullId}"`);
    }
    this.map.set(shortId, fullId);
  }
  delete(shortId: ShortTaskId): void { this.map.delete(shortId); }
  resolve(shortId: string): FullTaskId | undefined { return this.map.get(shortId); }
  deriveShortId(fullId: FullTaskId): ShortTaskId { return makeShortTaskId(fullId.slice(0, 8)); }
  rebuildFromDisk(_fs: unknown, _auditWriter?: ShortIdIndexAuditWriter): void { /* no-op */ }
}

export class PersistentShortIdIndex implements ShortIdIndex {
  private map: ShortIdMap = {};
  private dirty = false;
  needsRebuild = false;

  constructor(private fs: FileSystem) {}

  /** Load index from disk. Idempotent — safe to call on startup. */
  load(auditWriter?: ShortIdIndexAuditWriter): void {
    try {
      const raw = this.fs.readSync(INDEX_PATH);
      this.map = JSON.parse(raw) as ShortIdMap;
      this.needsRebuild = false;
    } catch (e: unknown) {
      if (isFileNotFound(e)) {
        this.map = {};
        this.needsRebuild = true; // missing index → rebuild from disk
        return;
      }
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED, {
        errno: (e as { code?: string }).code ?? 'UNKNOWN',
        error: String(e),
      });
      this.map = {};
      this.needsRebuild = true;
    }
  }

  /** Persist to disk if dirty. Call after add/delete. */
  save(): void {
    if (!this.dirty) return;
    this.fs.writeAtomicSync(INDEX_PATH, JSON.stringify(this.map, null, 2));
    this.dirty = false;
  }

  has(shortId: string): boolean {
    return shortId in this.map;
  }

  add(shortId: ShortTaskId, fullId: FullTaskId, auditWriter?: ShortIdIndexAuditWriter): void {
    if (shortId in this.map && this.map[shortId] !== fullId) {
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_COLLISION, {
        shortId,
        existingFullId: this.map[shortId],
        conflictingFullId: fullId,
      });
      throw new Error(`ShortId collision: "${shortId}" already maps to "${this.map[shortId]}", cannot add "${fullId}"`);
    }
    this.map[shortId] = fullId;
    this.dirty = true;
  }

  delete(shortId: ShortTaskId): void {
    delete this.map[shortId];
    this.dirty = true;
  }

  resolve(shortId: string): FullTaskId | undefined {
    const full = this.map[shortId];
    return full ? makeFullTaskId(full) : undefined;
  }

  /** Derive shortId from fullId (first 8 chars). */
  deriveShortId(fullId: FullTaskId): ShortTaskId {
    return makeShortTaskId(fullId.slice(0, 8));
  }

  /**
   * Rebuild the shortId index from all task files on disk.
   * Called when the index file is corrupted or missing, or on first migration.
   */
  rebuildFromDisk(
    fs: {
      existsSync(path: string): boolean;
      listSync(path: string, opts?: { includeDirs?: boolean }): Array<{ name: string }>;
      readSync(path: string): string;
    },
    auditWriter?: ShortIdIndexAuditWriter,
  ): void {
    this.map = {};
    const collisions: Array<{ shortId: string; existingFullId: string; newFullId: string }> = [];

    for (const dir of [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.listSync(dir, { includeDirs: false })) {
        if (!entry.name.endsWith('.json')) continue;
        try {
          const raw = fs.readSync(`${dir}/${entry.name}`);
          const task = JSON.parse(raw) as Record<string, unknown>;
          const storedId = task.id as string | undefined;
          if (!storedId) continue;

          let fullId: FullTaskId;
          let shortId: ShortTaskId;
          if (storedId.length === 36) {
            fullId = makeFullTaskId(storedId);
            shortId = this.deriveShortId(fullId);
          } else {
            // Old 8-char task: preserve the filename / old task.id as shortId
            shortId = makeShortTaskId(storedId);
            fullId = makeFullTaskId(newUuid());
          }

          if (shortId in this.map && this.map[shortId] !== fullId) {
            collisions.push({ shortId, existingFullId: this.map[shortId], newFullId: fullId });
            continue; // keep first mapping, report collision
          }
          this.map[shortId] = fullId;
        } catch {
          // silent: corrupted file — skip (recovery handles it separately)
        }
      }
    }

    this.dirty = true;

    if (collisions.length > 0) {
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_COLLISION, {
        collisions: collisions.map(c => ({
          shortId: c.shortId,
          existingFullId: c.existingFullId,
          conflictingFullId: c.newFullId,
        })),
      });
    }

    auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_INDEX_REBUILT, {
      entryCount: Object.keys(this.map).length,
      collisionCount: collisions.length,
    });
  }
}
