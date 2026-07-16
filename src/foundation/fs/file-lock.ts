/**
 * @module L1.FileSystem
 *
 * OS advisory file lock primitives.
 *
 * Uses the kernel flock(2) primitive via fs-ext. The lock is bound to the file
 * descriptor; closing the fd (or process termination) releases the lock
 * automatically. Non-authoritative metadata files are written for observability
 * only — they never participate in the mutual-exclusion decision.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { flockSync, constants as flockConstants } from 'fs-ext';
import { newShortUuid } from '../node-utils/index.js';
import { getProcessStartTime } from '../process-exec/index.js';
import { writeAtomicSync } from './atomic.js';

const LOCK_EX = flockConstants.LOCK_EX;
const LOCK_NB = flockConstants.LOCK_NB;
const LOCK_UN = flockConstants.LOCK_UN;

const METADATA_SUFFIX = '.metadata';
const POLL_INTERVAL_MS = 50;

export interface FileLockHandle {
  readonly resource: string;
  readonly ownerToken: string;
  release(): Promise<void>;
}

export interface FileLockSystem {
  /** Block until the lock is acquired or the timeout expires. The signal can cancel waiting. */
  acquire(resource: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FileLockHandle>;

  /** Non-blocking attempt. Returns null if the lock is already held. */
  tryAcquire(resource: string): Promise<FileLockHandle | null>;
}

export interface SyncFileLockHandle {
  readonly resource: string;
  readonly ownerToken: string;
  release(): void;
}

export interface SyncFileLockSystem {
  tryAcquire(resource: string): SyncFileLockHandle | null;
}

export class LockTimeoutError extends Error {
  constructor(
    public readonly resource: string,
    public readonly timeoutMs: number,
  ) {
    super(`Timeout acquiring lock for resource "${resource}" after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

export class LockAbortedError extends Error {
  constructor(public readonly resource: string) {
    super(`Lock acquisition for resource "${resource}" was aborted`);
    this.name = 'LockAbortedError';
  }
}

function ensureLockFile(resource: string): number {
  const dir = path.dirname(resource);
  fs.mkdirSync(dir, { recursive: true });
  return fs.openSync(resource, 'w+');
}

function closeFdBestEffort(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // best-effort
  }
}

function unlockFdBestEffort(fd: number): void {
  try {
    flockSync(fd, LOCK_UN);
  } catch {
    // fd may already be closed
  }
}

function isContentionError(err: unknown): boolean {
  return (
    (err as NodeJS.ErrnoException).code === 'EAGAIN' ||
    (err as NodeJS.ErrnoException).code === 'EACCES'
  );
}

function writeLockMetadata(resource: string, handle: { ownerToken: string }): void {
  const metaPath = `${resource}${METADATA_SUFFIX}`;

  // Archive any metadata left behind by a crash. The kernel lock is the source
  // of truth; metadata exists only for observability.
  if (fs.existsSync(metaPath)) {
    archiveOrphanedMetadata(resource);
  }

  const meta = {
    resource,
    pid: process.pid,
    startTime: getProcessStartTime(process.pid) ?? '0',
    ownerToken: handle.ownerToken,
    acquiredAt: Date.now(),
  };

  try {
    writeAtomicSync(metaPath, JSON.stringify(meta));
  } catch {
    // metadata is best-effort observability; do not fail the lock
  }
}

function archiveOrphanedMetadata(resource: string): void {
  const metaPath = `${resource}${METADATA_SUFFIX}`;
  const orphanPath = `${resource}${METADATA_SUFFIX}.orphaned-${Date.now()}`;
  try {
    fs.renameSync(metaPath, orphanPath);
  } catch {
    // best-effort archive
  }
}

function deleteLockMetadata(resource: string): void {
  try {
    fs.unlinkSync(`${resource}${METADATA_SUFFIX}`);
  } catch {
    // best-effort
  }
}

class FsExtLockHandle implements FileLockHandle {
  private _released = false;
  public readonly ownerToken: string;

  constructor(
    public readonly resource: string,
    private readonly _fd: number,
  ) {
    this.ownerToken = newShortUuid();
    writeLockMetadata(resource, this);
  }

  async release(): Promise<void> {
    if (this._released) return;
    this._released = true;
    deleteLockMetadata(this.resource);
    unlockFdBestEffort(this._fd);
    closeFdBestEffort(this._fd);
  }
}

class SyncFsExtLockHandle implements SyncFileLockHandle {
  private _released = false;
  public readonly ownerToken: string;

  constructor(
    public readonly resource: string,
    private readonly _fd: number,
  ) {
    this.ownerToken = newShortUuid();
    writeLockMetadata(resource, this);
  }

  release(): void {
    if (this._released) return;
    this._released = true;
    deleteLockMetadata(this.resource);
    unlockFdBestEffort(this._fd);
    closeFdBestEffort(this._fd);
  }
}

function tryAcquireFd(fd: number): boolean {
  try {
    flockSync(fd, LOCK_EX | LOCK_NB);
    return true;
  } catch (err) {
    if (isContentionError(err)) return false;
    throw err;
  }
}

export const fileLockSystem: FileLockSystem = {
  async tryAcquire(resource: string): Promise<FileLockHandle | null> {
    const fd = ensureLockFile(resource);
    if (!tryAcquireFd(fd)) {
      closeFdBestEffort(fd);
      return null;
    }
    return new FsExtLockHandle(resource, fd);
  },

  async acquire(resource: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FileLockHandle> {
    const fd = ensureLockFile(resource);
    const deadline = options?.timeoutMs ? Date.now() + options.timeoutMs : undefined;

    try {
      while (true) {
        if (options?.signal?.aborted) {
          throw new LockAbortedError(resource);
        }
        if (tryAcquireFd(fd)) {
          return new FsExtLockHandle(resource, fd);
        }

        if (deadline !== undefined && Date.now() >= deadline) {
          throw new LockTimeoutError(resource, options!.timeoutMs!);
        }
        if (options?.signal?.aborted) {
          throw new LockAbortedError(resource);
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err) {
      closeFdBestEffort(fd);
      throw err;
    }
  },
};

export const syncFileLockSystem: SyncFileLockSystem = {
  tryAcquire(resource: string): SyncFileLockHandle | null {
    const fd = ensureLockFile(resource);
    if (!tryAcquireFd(fd)) {
      closeFdBestEffort(fd);
      return null;
    }
    return new SyncFsExtLockHandle(resource, fd);
  },
};

/** Archive leftover metadata from a previous crash. Exposed for tests. */
export function archiveLockMetadata(resource: string): void {
  archiveOrphanedMetadata(resource);
}
