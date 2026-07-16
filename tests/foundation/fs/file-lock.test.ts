/**
 * Phase 1061: OS advisory file lock primitive tests.
 *
 * Exercises the kernel-backed lock implementation across single-process and
 * multi-process scenarios. File descriptor bound locks guarantee release on
 * process exit, so SIGKILL recovery is a key property.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  fileLockSystem,
  syncFileLockSystem,
  archiveLockMetadata,
  LockTimeoutError,
  LockAbortedError,
} from '../../../src/foundation/fs/file-lock.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase1061-${randomUUID()}-`));
}

function lockPath(dir: string, resource = 'resource'): string {
  return path.join(dir, `${resource}.lock`);
}

function metadataPath(lockFile: string): string {
  return `${lockFile}.metadata`;
}

/** Spawn a child process that acquires the lock and reports readiness. */
function spawnLocker(lockFile: string): { child: ReturnType<typeof spawn>; ready: Promise<void> } {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
        const fs = require('fs');
        const { flockSync, constants } = require('fs-ext');
        const fd = fs.openSync(process.argv[1], 'w+');
        fs.mkdirSync(require('path').dirname(process.argv[1]), { recursive: true });
        flockSync(fd, constants.LOCK_EX | constants.LOCK_NB);
        console.log('locked');
        const KEEPALIVE_INTERVAL_MS = 1000; // hold fd open until parent signals exit
        setInterval(() => {}, KEEPALIVE_INTERVAL_MS);
      `,
      lockFile,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const ready = new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) resolve();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== null && code !== 0 && !stderr.includes('locked')) {
        reject(new Error(`locker exited unexpectedly: ${code}\n${stderr}`));
      }
    });
    const LOCKER_STARTUP_TIMEOUT_MS = 5000; // process spawn + flock should complete well within this
    setTimeout(() => reject(new Error(`locker startup timed out: ${stderr}`)), LOCKER_STARTUP_TIMEOUT_MS);
  });

  return { child, ready };
}

describe('file-lock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('async', () => {
    it('acquires and releases a lock in the same process', async () => {
      const resource = lockPath(tempDir);
      const handle = await fileLockSystem.acquire(resource);
      expect(handle.resource).toBe(resource);
      expect(handle.ownerToken).toHaveLength(8);

      await handle.release();
      const second = await fileLockSystem.acquire(resource);
      expect(second.ownerToken).not.toBe(handle.ownerToken);
      await second.release();
    });

    it('tryAcquire returns null when lock is already held by another process', async () => {
      const resource = lockPath(tempDir);
      const { child, ready } = spawnLocker(resource);
      try {
        await ready;
        const attempt = await fileLockSystem.tryAcquire(resource);
        expect(attempt).toBeNull();
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('acquire succeeds after holding process is SIGKILLed', async () => {
      const resource = lockPath(tempDir);
      const { child, ready } = spawnLocker(resource);
      await ready;
      child.kill('SIGKILL');

      // The kernel releases the fd-bound lock on process termination.
      const handle = await fileLockSystem.acquire(resource, { timeoutMs: 5000 });
      expect(handle.resource).toBe(resource);
      await handle.release();
    });

    it('release is idempotent', async () => {
      const resource = lockPath(tempDir);
      const handle = await fileLockSystem.acquire(resource);
      await handle.release();
      await handle.release();
      await handle.release();
      // A fresh acquire proves the lock was actually released.
      const next = await fileLockSystem.acquire(resource);
      await next.release();
    });

    it('throws LockTimeoutError when timeout expires', async () => {
      const resource = lockPath(tempDir);
      const { child, ready } = spawnLocker(resource);
      try {
        await ready;
        await expect(fileLockSystem.acquire(resource, { timeoutMs: 80 })).rejects.toBeInstanceOf(
          LockTimeoutError,
        );
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('throws LockAbortedError when signal is already aborted', async () => {
      const resource = lockPath(tempDir);
      const controller = new AbortController();
      controller.abort();
      await expect(fileLockSystem.acquire(resource, { signal: controller.signal })).rejects.toBeInstanceOf(
        LockAbortedError,
      );
    });

    it('aborts waiting via signal while another process holds the lock', async () => {
      const resource = lockPath(tempDir);
      const { child, ready } = spawnLocker(resource);
      try {
        await ready;
        const controller = new AbortController();
        const promise = fileLockSystem.acquire(resource, { signal: controller.signal });
        const ABORT_AFTER_MS = 50; // shorter than poll interval to prove signal cancels wait
        setTimeout(() => controller.abort(), ABORT_AFTER_MS);
        await expect(promise).rejects.toBeInstanceOf(LockAbortedError);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('locks for different resources do not block each other', async () => {
      const a = lockPath(tempDir, 'a');
      const b = lockPath(tempDir, 'b');
      const handleA = await fileLockSystem.acquire(a);
      const handleB = await fileLockSystem.acquire(b);
      await handleA.release();
      await handleB.release();
    });

    it('writes metadata on acquire and removes it on release', async () => {
      const resource = lockPath(tempDir);
      const handle = await fileLockSystem.acquire(resource);
      const metaPath = metadataPath(resource);
      expect(fs.existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      expect(meta.resource).toBe(resource);
      expect(meta.pid).toBe(process.pid);
      expect(meta.ownerToken).toBe(handle.ownerToken);
      expect(typeof meta.acquiredAt).toBe('number');

      await handle.release();
      expect(fs.existsSync(metaPath)).toBe(false);
    });

    it('archives orphaned metadata before writing new metadata', async () => {
      const resource = lockPath(tempDir);
      const metaPath = metadataPath(resource);
      fs.mkdirSync(path.dirname(resource), { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({ resource, ownerToken: 'orphan' }), { flag: 'wx' });

      archiveLockMetadata(resource);
      expect(fs.existsSync(metaPath)).toBe(false);
      const orphans = fs.readdirSync(tempDir).filter((n) => n.includes('.metadata.orphaned-'));
      expect(orphans).toHaveLength(1);
    });
  });

  describe('sync', () => {
    it('tryAcquire returns a handle when free', () => {
      const resource = lockPath(tempDir);
      const handle = syncFileLockSystem.tryAcquire(resource);
      expect(handle).not.toBeNull();
      expect(handle!.resource).toBe(resource);
      handle!.release();
    });

    it('tryAcquire returns null when lock is already held', () => {
      const resource = lockPath(tempDir);
      const first = syncFileLockSystem.tryAcquire(resource);
      expect(first).not.toBeNull();
      const second = syncFileLockSystem.tryAcquire(resource);
      expect(second).toBeNull();
      first!.release();
    });

    it('release is idempotent', () => {
      const resource = lockPath(tempDir);
      const handle = syncFileLockSystem.tryAcquire(resource)!;
      handle.release();
      handle.release();
      const next = syncFileLockSystem.tryAcquire(resource);
      expect(next).not.toBeNull();
      next!.release();
    });

    it('writes and removes metadata', () => {
      const resource = lockPath(tempDir);
      const handle = syncFileLockSystem.tryAcquire(resource)!;
      const metaPath = metadataPath(resource);
      expect(fs.existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      expect(meta.ownerToken).toBe(handle.ownerToken);
      handle.release();
      expect(fs.existsSync(metaPath)).toBe(false);
    });
  });
});
