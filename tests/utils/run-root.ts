import * as path from 'node:path';

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
