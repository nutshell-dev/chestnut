import { promises as fs } from 'node:fs';
import { rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export async function createTempDir(prefix = 'chestnut-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 登记表：记录本 worker 创建的所有临时目录 */
const trackedDirs = new Set<string>();

/**
 * 创建临时目录并自动登记。
 * 与 createTempDir 等效，但目录会在 teardown 时被统一清理。
 */
export async function createTrackedTempDir(prefix = 'chestnut-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  trackedDirs.add(dir);
  return dir;
}

export function createTrackedTempDirSync(prefix = 'chestnut-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedDirs.add(dir);
  return dir;
}

/** 从登记表移除（手动 cleanup 后调用） */
export function untrackTempDir(dir: string): void {
  trackedDirs.delete(dir);
}

/** 清理所有已登记目录。由 vitest teardown 或 afterAll 调用。 */
export async function cleanupAllTrackedDirs(): Promise<void> {
  const errors: Array<{ dir: string; error: string }> = [];
  for (const dir of trackedDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      trackedDirs.delete(dir);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        trackedDirs.delete(dir);
        continue;
      }
      errors.push({ dir, error: err?.message ?? String(err) });
    }
  }
  if (errors.length > 0) {
    throw new Error(`Failed to clean up ${errors.length} temp dirs:\n${
      errors.map(e => `  ${e.dir}: ${e.error}`).join('\n')
    }`);
  }
}

/** 返回当前登记目录快照（用于审计） */
export function getTrackedDirs(): ReadonlySet<string> {
  return trackedDirs;
}

export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    untrackTempDir(tempDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      untrackTempDir(tempDir);
      return;
    }
    console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
  }
}

export function cleanupTempDirSync(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
    untrackTempDir(tempDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      untrackTempDir(tempDir);
      return;
    }
    console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
  }
}
