/**
 * @module L4.AsyncTaskSystem.ShortIdIndex
 *
 * Phase 849: shortId ↔ fullId mapping index persisted at
 * tasks/queues/short-id-map.json.
 * Phase 854: load() distinguishes ENOENT from corruption/IO errors, rebuilds
 * from disk when needed, and add() rejects collisions.
 * Phase 888: bidirectional Map, dual-direction collision checks, rebuild
 * field validation, and canonicalShortId no longer derives for unknown fullIds.
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
const SHORT_ID_RE = /^[0-9a-f]{8}$/;
const FULL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ShortIdMap {
  [shortId: string]: string; // shortId → full UUID string
}

export interface ShortIdIndexAuditWriter {
  write(event: string, payload: Record<string, unknown>): void;
}

/** In-memory ShortIdIndex for tests or lightweight scenarios. */
export class InMemoryShortIdIndex implements ShortIdIndex {
  readonly needsRebuild = false;
  private shortToFull = new Map<string, FullTaskId>();
  private fullToShort = new Map<FullTaskId, ShortTaskId>();

  load(_auditWriter?: ShortIdIndexAuditWriter): void { /* no-op */ }
  save(): void { /* no-op */ }
  has(shortId: string): boolean { return this.shortToFull.has(shortId); }

  add(shortId: ShortTaskId, fullId: FullTaskId, auditWriter?: ShortIdIndexAuditWriter, context?: string): void {
    // Check shortId → fullId uniqueness
    const existingFull = this.shortToFull.get(shortId);
    if (existingFull && existingFull !== fullId) {
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_COLLISION, {
        direction: 'short_to_full',
        shortId,
        existingFullId: existingFull,
        conflictingFullId: fullId,
        context: context ?? 'add',
      });
      throw new Error(`ShortId collision: "${shortId}" already maps to "${existingFull}", cannot add "${fullId}"`);
    }

    // Check fullId → shortId uniqueness
    const existingShort = this.fullToShort.get(fullId);
    if (existingShort && existingShort !== shortId) {
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_COLLISION, {
        direction: 'full_to_short',
        shortId,
        existingShortId: existingShort,
        conflictingShortId: shortId,
        fullId,
        context: context ?? 'add',
      });
      throw new Error(`ShortId collision: fullId "${fullId}" already mapped to "${existingShort}", cannot add "${shortId}"`);
    }

    this.shortToFull.set(shortId, fullId);
    this.fullToShort.set(fullId, shortId);
  }

  delete(shortId: ShortTaskId): void {
    const fullId = this.shortToFull.get(shortId);
    if (fullId) this.fullToShort.delete(fullId);
    this.shortToFull.delete(shortId);
  }

  resolve(shortId: string): FullTaskId | undefined { return this.shortToFull.get(shortId); }

  reverseResolve(fullId: FullTaskId): ShortTaskId | undefined {
    return this.fullToShort.get(fullId);
  }

  deriveShortId(fullId: FullTaskId): ShortTaskId { return makeShortTaskId(fullId.slice(0, 8)); }

  canonicalShortId(fullId: FullTaskId): ShortTaskId | undefined {
    return this.reverseResolve(fullId); // no fallback derive
  }

  rebuildFromDisk(_fs: unknown, _auditWriter?: ShortIdIndexAuditWriter): void { /* no-op */ }
}

export class PersistentShortIdIndex implements ShortIdIndex {
  private shortToFull = new Map<string, FullTaskId>();
  private fullToShort = new Map<FullTaskId, ShortTaskId>();
  private dirty = false;
  needsRebuild = false;

  constructor(private fs: FileSystem) {}

  /** Load index from disk. Idempotent — safe to call on startup. */
  load(auditWriter?: ShortIdIndexAuditWriter): void {
    try {
      const raw = this.fs.readSync(INDEX_PATH);
      const parsed: unknown = JSON.parse(raw);

      // Phase 867: validate index schema — reject null / arrays / non-object roots
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('ShortIdIndex: root must be a plain object');
      }
      const map = parsed as Record<string, unknown>;

      const newShortToFull = new Map<string, FullTaskId>();
      const newFullToShort = new Map<FullTaskId, ShortTaskId>();

      for (const [key, value] of Object.entries(map)) {
        if (key.length !== 8 || !SHORT_ID_RE.test(key)) {
          throw new Error(`ShortIdIndex: invalid shortId key "${key}"`);
        }
        if (typeof value !== 'string' || !FULL_ID_RE.test(value)) {
          throw new Error(`ShortIdIndex: invalid fullId value for "${key}": ${String(value)}`);
        }
        const fullId = makeFullTaskId(value);
        const shortId = makeShortTaskId(key);

        // Phase 902: check fullId → shortId uniqueness
        const existingShort = newFullToShort.get(fullId);
        if (existingShort && existingShort !== shortId) {
          throw new Error(
            `ShortIdIndex: fullId "${value}" already mapped to "${existingShort}", cannot also map to "${key}"`
          );
        }

        newShortToFull.set(key, fullId);
        newFullToShort.set(fullId, shortId);
      }

      this.shortToFull = newShortToFull;
      this.fullToShort = newFullToShort;
      this.needsRebuild = false;
    } catch (e: unknown) {
      if (isFileNotFound(e)) {
        this.shortToFull = new Map();
        this.fullToShort = new Map();
        this.needsRebuild = true; // missing index → rebuild from disk
        return;
      }
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED, {
        errno: (e as { code?: string }).code ?? 'UNKNOWN',
        error: String(e),
      });
      this.shortToFull = new Map();
      this.fullToShort = new Map();
      this.needsRebuild = true;
    }
  }

  /** Persist to disk if dirty. Call after add/delete. */
  save(): void {
    if (!this.dirty) return;
    const map: ShortIdMap = {};
    for (const [shortId, fullId] of this.shortToFull.entries()) {
      map[shortId] = fullId;
    }
    this.fs.writeAtomicSync(INDEX_PATH, JSON.stringify(map, null, 2));
    this.dirty = false;
  }

  has(shortId: string): boolean {
    return this.shortToFull.has(shortId);
  }

  add(shortId: ShortTaskId, fullId: FullTaskId, auditWriter?: ShortIdIndexAuditWriter, context?: string): void {
    // Check shortId → fullId uniqueness
    const existingFull = this.shortToFull.get(shortId);
    if (existingFull && existingFull !== fullId) {
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_COLLISION, {
        direction: 'short_to_full',
        shortId,
        existingFullId: existingFull,
        conflictingFullId: fullId,
        context: context ?? 'add',
      });
      throw new Error(`ShortId collision: "${shortId}" already maps to "${existingFull}", cannot add "${fullId}"`);
    }

    // Check fullId → shortId uniqueness
    const existingShort = this.fullToShort.get(fullId);
    if (existingShort && existingShort !== shortId) {
      auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_COLLISION, {
        direction: 'full_to_short',
        shortId,
        existingShortId: existingShort,
        conflictingShortId: shortId,
        fullId,
        context: context ?? 'add',
      });
      throw new Error(`ShortId collision: fullId "${fullId}" already mapped to "${existingShort}", cannot add "${shortId}"`);
    }

    this.shortToFull.set(shortId, fullId);
    this.fullToShort.set(fullId, shortId);
    this.dirty = true;
  }

  delete(shortId: ShortTaskId): void {
    const fullId = this.shortToFull.get(shortId);
    if (fullId) this.fullToShort.delete(fullId);
    this.shortToFull.delete(shortId);
    this.dirty = true;
  }

  resolve(shortId: string): FullTaskId | undefined {
    return this.shortToFull.get(shortId);
  }

  reverseResolve(fullId: FullTaskId): ShortTaskId | undefined {
    return this.fullToShort.get(fullId);
  }

  /** Derive shortId from fullId (first 8 chars). */
  deriveShortId(fullId: FullTaskId): ShortTaskId {
    return makeShortTaskId(fullId.slice(0, 8));
  }

  canonicalShortId(fullId: FullTaskId): ShortTaskId | undefined {
    return this.reverseResolve(fullId); // no fallback derive
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
    this.shortToFull = new Map();
    this.fullToShort = new Map();
    const collisions: Array<Record<string, string>> = [];

    for (const dir of [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.listSync(dir, { includeDirs: false })) {
        if (!entry.name.endsWith('.json')) continue;
        try {
          const raw = fs.readSync(`${dir}/${entry.name}`);
          const task = JSON.parse(raw) as Record<string, unknown>;
          const storedId = task.id as string | undefined;
          const storedShortId = task.shortId as string | undefined;
          if (!storedId) continue;

          let fullId: FullTaskId;
          let shortId: ShortTaskId;

          if (storedShortId && storedId.length === 36) {
            // Phase 867+: explicit dual-key — authoritative
            fullId = makeFullTaskId(storedId);
            shortId = makeShortTaskId(storedShortId);
          } else if (storedId.length === 36) {
            // Pre-867 UUID task without explicit shortId → derive
            fullId = makeFullTaskId(storedId);
            shortId = this.deriveShortId(fullId);
          } else {
            // Legacy 8-char task — preserve id as shortId, generate fullId
            shortId = makeShortTaskId(storedId);
            fullId = makeFullTaskId(newUuid());
          }

          // Phase 888: validate shortId format before indexing
          if (!SHORT_ID_RE.test(shortId)) {
            auditWriter?.write(TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED, {
              path: `${dir}/${entry.name}`,
              storedShortId: storedShortId ?? '(none)',
              derivedShortId: shortId,
              error: 'invalid shortId format in rebuild',
              context: 'rebuild_skip_invalid',
            });
            continue;
          }

          if (this.shortToFull.has(shortId) && this.shortToFull.get(shortId) !== fullId) {
            collisions.push({ shortId, existingFullId: this.shortToFull.get(shortId)!, newFullId: fullId });
            continue; // keep first mapping, report collision
          }

          // Phase 902: check fullId → shortId uniqueness
          if (this.fullToShort.has(fullId) && this.fullToShort.get(fullId) !== shortId) {
            collisions.push({
              direction: 'full_to_short',
              fullId,
              existingShortId: this.fullToShort.get(fullId)!,
              conflictingShortId: shortId,
            });
            continue; // keep first mapping, report collision
          }

          this.shortToFull.set(shortId, fullId);
          this.fullToShort.set(fullId, shortId);
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
      entryCount: this.shortToFull.size,
      collisionCount: collisions.length,
    });
  }
}
