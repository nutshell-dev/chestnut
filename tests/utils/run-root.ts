import * as path from 'node:path';
import * as os from 'node:os';

/** 获取当前 invocation 运行根目录路径 */
export function getRunRoot(): string | undefined {
  return process.env.CHESTNUT_RUN_ROOT;
}

/** 在运行根目录下创建子目录（用于需要独立空间的场景） */
export function getRunSubDir(name: string): string | undefined {
  const root = getRunRoot();
  if (!root) return undefined;
  return path.join(root, name);
}

/** 返回真实系统 tmpdir（在 TMPDIR 被重定向后仍可用） */
export function getHostTmpDir(): string {
  // HOST_TMPDIR 由 globalSetup 在重定向前写入环境变量
  // run-root.ts 是获取真实系统 tmpdir 的专用入口，允许直接 fallback 到 os.tmpdir()
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  return process.env.CHESTNUT_HOST_TMPDIR ?? os.tmpdir();
}
