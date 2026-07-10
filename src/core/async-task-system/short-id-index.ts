/**
 * @module L4.AsyncTaskSystem.ShortIdIndex
 *
 * Phase 849: shortId ↔ fullId mapping index persisted at
 * tasks/queues/short-id-map.json.
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { FullTaskId, ShortTaskId, ShortIdIndex } from './types.js';
import { makeFullTaskId, makeShortTaskId } from './types.js';

const INDEX_PATH = 'tasks/queues/short-id-map.json';

export interface ShortIdMap {
  [shortId: string]: string; // shortId → full UUID string
}

export class PersistentShortIdIndex implements ShortIdIndex {
  private map: ShortIdMap = {};
  private dirty = false;

  constructor(private fs: FileSystem) {}

  /** Load index from disk. Idempotent — safe to call on startup. */
  load(): void {
    try {
      const raw = this.fs.readSync(INDEX_PATH);
      this.map = JSON.parse(raw) as ShortIdMap;
    } catch {
      this.map = {};
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

  add(shortId: ShortTaskId, fullId: FullTaskId): void {
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
}
