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
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRunRoot } from './run-root.js';
import {
  beginRetentionScope,
  inspectRetention,
  type RetentionDecision,
  type RetentionScope,
} from './resource-retention.js';

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

/** Persist protection before creating the directory it covers. */
export function createScopedTempDirSync(prefix = 'chestnut-test-'): {
  dir: string;
  retention: RetentionScope;
} {
  const runRoot = getRunRoot();
  if (!runRoot) throw new Error('createScopedTempDirSync requires CHESTNUT_RUN_ROOT');
  if (prefix.includes('/') || prefix.includes('\\') || prefix === '.' || prefix === '..') {
    throw new Error(`Scoped temp prefix must stay directly under the run root: ${prefix}`);
  }
  const dir = path.join(runRoot, `${prefix}${randomUUID()}`);
  if (path.dirname(path.resolve(dir)) !== path.resolve(runRoot)) {
    throw new Error(`Scoped temp path escapes run root: ${dir}`);
  }
  const retention = beginRetentionScope({
    runRoot,
    protectedPaths: [dir],
    label: `temp:${prefix}`,
  });
  mkdirSync(dir);
  trackedDirs.add(dir);
  return { dir, retention };
}

/** 从登记表移除（手动 cleanup 后调用） */
export function untrackTempDir(dir: string): void {
  trackedDirs.delete(dir);
}

function retentionFor(tempDir: string): RetentionDecision {
  const runRoot = getRunRoot();
  return runRoot ? inspectRetention(runRoot, tempDir) : { kind: 'allow' };
}

function reportPreserved(tempDir: string, decision: Extract<RetentionDecision, { kind: 'preserve' }>): void {
  console.warn(
    `[test cleanup] Preserved ${tempDir} by retention scopes=${decision.scopeIds.join(',') || 'legacy'} ` +
    `reasons=${decision.reasons.join(',')}`,
  );
}

function indeterminateCleanupError(tempDir: string, error: unknown): Error {
  return new Error(`Cannot determine whether temp dir ${tempDir} is safe to clean`, { cause: error });
}

/** 清理所有已登记目录。由 vitest teardown 或 afterAll 调用。 */
export async function cleanupAllTrackedDirs(): Promise<void> {
  const errors: Array<{ dir: string; error: string }> = [];
  for (const dir of trackedDirs) {
    const decision = retentionFor(dir);
    if (decision.kind === 'preserve') {
      reportPreserved(dir, decision);
      continue;
    }
    if (decision.kind === 'indeterminate') {
      errors.push({ dir, error: String(decision.error) });
      continue;
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      trackedDirs.delete(dir);
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'EINVAL' || err?.code === 'ENOTEMPTY') {
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
  const decision = retentionFor(tempDir);
  if (decision.kind === 'preserve') {
    reportPreserved(tempDir, decision);
    return;
  }
  if (decision.kind === 'indeterminate') throw indeterminateCleanupError(tempDir, decision.error);
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    untrackTempDir(tempDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'EINVAL' || err?.code === 'ENOTEMPTY') {
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
  const decision = retentionFor(tempDir);
  if (decision.kind === 'preserve') {
    reportPreserved(tempDir, decision);
    return;
  }
  if (decision.kind === 'indeterminate') throw indeterminateCleanupError(tempDir, decision.error);
  try {
    rmSync(tempDir, { recursive: true, force: true });
    untrackTempDir(tempDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'EINVAL' || err?.code === 'ENOTEMPTY') {
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
