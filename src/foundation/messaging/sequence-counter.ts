/**
 * Per-claw monotonic sequence counter for messaging filenames.
 *
 * Persisted in `<clawDir>/.next-msg-seq`. The async path serializes concurrent
 * increments via an internal promise chain; the sync path uses sync fs methods
 * and is intended for the single-process-per-claw `writeSync()` hot path.
 *
 * phase 286 Step A: replaces uuid8 suffix to strictly eliminate filename
 * collision possibility (CC-1/CC-2).
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';

const SEQ_FILENAME = '.next-msg-seq';
const SEQ_PAD_LEN = 10;

export class SequenceCounter {
  private pending: Promise<unknown> | undefined;

  constructor(
    private readonly fs: FileSystem,
    private readonly clawDir: string,
  ) {}

  /** Async increment: queued so consecutive calls on the same instance are serialized. */
  async next(): Promise<number> {
    const prev = this.pending;
    const p = (async (): Promise<number> => {
      await prev;
      const seqFile = path.join(this.clawDir, SEQ_FILENAME);
      let seq = 0;
      try {
        const raw = await this.fs.read(seqFile);
        seq = parseInt(raw, 10);
        if (!Number.isFinite(seq) || seq < 0) seq = 0;
      } catch (e) {
        if (!isFileNotFound(e)) throw e;
      }
      seq++;
      await this.fs.writeAtomic(seqFile, String(seq));
      return seq;
    })();
    this.pending = p;
    return p;
  }

  /** Sync increment: read current seq, increment, persist atomically. */
  nextSync(): number {
    const seqFile = path.join(this.clawDir, SEQ_FILENAME);
    let seq = 0;
    try {
      const raw = this.fs.readSync(seqFile);
      seq = parseInt(raw, 10);
      if (!Number.isFinite(seq) || seq < 0) seq = 0;
    } catch (e) {
      if (!isFileNotFound(e)) throw e;
    }
    seq++;
    this.fs.writeAtomicSync(seqFile, String(seq));
    return seq;
  }
}

/** Format a sequence number as a zero-padded filename component. */
export function formatSeq(seq: number): string {
  return String(seq).padStart(SEQ_PAD_LEN, '0');
}
