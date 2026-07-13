/**
 * 测试临时资源的统一所有者。
 *
 * 推荐：所有新测试使用 `createTrackedTempDir` / `createTrackedTempDirSync`
 * 创建临时目录，这样目录会被自动登记并在 teardown 时统一清理。
 *
 * 阶段 1 invariant（phase 988）：
 * - 直接调用 `os.tmpdir()` / `fs.mkdtemp()` 在 tests/ 下被 eslint
 *   no-bare-tempdir-in-tests 规则拦截（allowlist 中的现有文件除外）。
 * - 清理失败默认 throw；设置 `CHESTNUT_KEEP_TEST_TMP=1` 可保留现场并跳过 throw。
 */

import { promises as fs } from 'node:fs';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export async function createTempDir(prefix = 'chestnut-test-'): Promise<string> {
  return createTrackedTempDir(prefix);
}

/** 登记表：记录本 worker 创建的所有临时目录 */
const trackedDirs = new Set<string>();

/**
 * 创建临时目录并自动登记。
 * 与 createTempDir 等效，但目录会在 teardown 时被统一清理。
 */
export async function createTrackedTempDir(prefix = 'chestnut-test-'): Promise<string> {
  // temp.ts 是统一封装层，允许直接调用 os.tmpdir()
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const parent = os.tmpdir();
  try { await fs.mkdir(parent, { recursive: true }); } catch { /* parent may already exist */ }
  const dir = await fs.mkdtemp(path.join(parent, prefix));
  trackedDirs.add(dir);
  return dir;
}

export function createTrackedTempDirSync(prefix = 'chestnut-test-'): string {
  // temp.ts 是统一封装层，允许直接调用 os.tmpdir()
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const parent = os.tmpdir();
  try { mkdirSync(parent, { recursive: true }); } catch { /* parent may already exist */ }
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const dir = mkdtempSync(path.join(parent, prefix));
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
    if (err?.code === 'ENOENT' || err?.code === 'EINVAL') {
      untrackTempDir(tempDir);
      return;
    }
    if (process.env.CHESTNUT_KEEP_TEST_TMP === '1') {
      console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
      console.warn(`[test cleanup] Preserved for inspection: ${tempDir}`);
      return;
    }
    throw new Error(`Failed to clean up temp dir ${tempDir}: ${err?.message ?? err}`, { cause: err });
  }
}

export function cleanupTempDirSync(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
    untrackTempDir(tempDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'EINVAL') {
      untrackTempDir(tempDir);
      return;
    }
    if (process.env.CHESTNUT_KEEP_TEST_TMP === '1') {
      console.warn(`[test cleanup] Failed to remove ${tempDir}: ${err?.message ?? err}`);
      console.warn(`[test cleanup] Preserved for inspection: ${tempDir}`);
      return;
    }
    throw new Error(`Failed to clean up temp dir ${tempDir}: ${err?.message ?? err}`, { cause: err });
  }
}
