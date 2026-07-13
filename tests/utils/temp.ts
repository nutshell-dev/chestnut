/**
 * 测试临时资源的统一所有者。
 *
 * 推荐：所有新测试使用 `createTrackedTempDir` / `createTrackedTempDirSync`
 * 创建临时目录，这样目录会被自动登记并在 teardown 时统一清理。
 *
 * 阶段 0 invariant：直接调用 `os.tmpdir()` / `fs.mkdtemp()` 仍被允许，
 * 但需把合理场景加入 TMPDIR_ALLOWLIST 并记录原因。
 */

import { promises as fs } from 'node:fs';
import { rmSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export async function createTempDir(prefix = 'chestnut-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 登记表：记录本 worker 创建的所有临时目录 */
const trackedDirs = new Set<string>();

/**
 * 文件/pattern 级 allowlist：这些调用方因合理原因（subprocess spawn、
 * 第三方库要求真实系统 tmpdir 等）需要直接使用 tmpdir/mkdtemp。
 *
 * 格式：glob pattern → 原因说明
 */
export const TMPDIR_ALLOWLIST = new Map<string, string>([
  // 阶段 0 baseline：当前无不允许直接调用的刚需场景；后续 phase 按实际调用方填充。
]);

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
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
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

const STRICT = process.env.CHESTNUT_STRICT_TEMP === '1';

export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    untrackTempDir(tempDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      untrackTempDir(tempDir);
      return;
    }
    if (STRICT) {
      throw new Error(`Failed to clean up temp dir ${tempDir}: ${err?.message ?? err}`, { cause: err });
    }
    if (process.env.CHESTNUT_KEEP_TEST_TMP === '1') {
      console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
      console.warn('[test cleanup] CHESTNUT_KEEP_TEST_TMP=1, preserving for inspection');
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
    if (STRICT) {
      throw new Error(`Failed to clean up temp dir ${tempDir}: ${err?.message ?? err}`, { cause: err });
    }
    if (process.env.CHESTNUT_KEEP_TEST_TMP === '1') {
      console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
      console.warn('[test cleanup] CHESTNUT_KEEP_TEST_TMP=1, preserving for inspection');
      return;
    }
    console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
  }
}
