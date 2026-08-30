/**
 * @module L2b.DialogStore.BlockIdIndex
 *
 * Phase 1186: blockId short ↔ full UUID mapping index persisted at
 * dialog/block-index.json.
 *
 * Follows the ShortIdIndex pattern:
 * - bidirectional short→full map
 * - collision detection on add()
 * - atomic persistence
 *
 * Differs from ShortIdIndex:
 * - Only short→full direction (no reverseResolve needed for blocks)
 * - No rebuild (archive scan is not feasible; index is cumulative)
 * - No delete (blocks are immutable)
 */

import * as path from 'path';
import { isFileNotFound } from '../fs/index.js';
import type { FileSystem } from '../fs/index.js';

const INDEX_FILENAME = 'block-index.json';

interface BlockIdMap {
  [shortId: string]: string; // 8-char shortId → full UUID
}

export interface BlockIdIndexAuditWriter {
  write(event: string, ...details: string[]): void;
}

export class BlockIdIndex {
  private shortToFull = new Map<string, string>();
  private dirty = false;

  constructor(
    private fs: FileSystem,
    private dialogDir: string,
  ) {}

  get indexPath(): string {
    return path.join(this.dialogDir, INDEX_FILENAME);
  }

  load(auditWriter?: BlockIdIndexAuditWriter): void {
    try {
      const raw = this.fs.readSync(this.indexPath);
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('BlockIdIndex: root must be a plain object');
      }
      const map = parsed as Record<string, unknown>;
      for (const [key, value] of Object.entries(map)) {
        if (typeof value !== 'string') continue;
        this.shortToFull.set(key, value);
      }
    } catch (e: unknown) {
      if (isFileNotFound(e)) {
        this.shortToFull = new Map();
        return;
      }
      auditWriter?.write(
        'block_id_index_load_failed',
        `reason=${String(e)}`,
      );
      this.shortToFull = new Map();
    }
  }

  save(): void {
    if (!this.dirty) return;
    const map: BlockIdMap = {};
    for (const [shortId, fullId] of this.shortToFull.entries()) {
      map[shortId] = fullId;
    }
    this.fs.writeAtomicSync(this.indexPath, JSON.stringify(map, null, 2));
    this.dirty = false;
  }

  add(shortId: string, fullId: string): void {
    const existingFull = this.shortToFull.get(shortId);
    if (existingFull !== undefined && existingFull !== fullId) {
      throw new Error(
        `BlockId collision: short="${shortId}" already maps to "${existingFull}", cannot add "${fullId}"`
      );
    }
    this.shortToFull.set(shortId, fullId);
    this.dirty = true;
  }

  resolve(shortId: string): string | undefined {
    return this.shortToFull.get(shortId);
  }

  get size(): number {
    return this.shortToFull.size;
  }
}
