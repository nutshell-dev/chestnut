/**
 * 字节保真递归目录复制（Phase 1919 Step B）。
 *
 * 本文件是 fs owner 内部的绝对路径复制原语：生产代码禁止直接 import node:fs
 * （depcruise 规则），需要跨 baseDir 边界的目录拷贝（版本库工作区填充、迁移
 * 备份）由 owner 以独立 helper 提供，不进 FileSystem 接口（baseDir 语义不适用）。
 *
 * 保真语义：常规文件字节与 mode（执行位）原样保留；符号链接按链接本身复制
 * （不跟随、不解引用）；FIFO/socket/device 等特殊条目拒绝复制（loud）。
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/** 递归复制 srcAbs 目录内容到 destAbs（destAbs 不存在或为空目录；调用方保证不重叠）。 */
export async function copyDirAbsolute(srcAbs: string, destAbs: string): Promise<void> {
  const srcStat = await fsp.lstat(srcAbs);
  if (!srcStat.isDirectory()) {
    throw new Error(`copyDirAbsolute: source is not a directory: ${srcAbs}`);
  }
  await fsp.mkdir(destAbs, { recursive: true });
  const entries = await fsp.readdir(srcAbs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const src = path.join(srcAbs, entry.name);
    const dest = path.join(destAbs, entry.name);
    if (entry.isDirectory()) {
      await copyDirAbsolute(src, dest);
    } else if (entry.isSymbolicLink()) {
      const target = await fsp.readlink(src);
      await fsp.symlink(target, dest);
    } else if (entry.isFile()) {
      await fsp.copyFile(src, dest);
      const st = await fsp.stat(src);
      await fsp.chmod(dest, st.mode & 0o777);
    } else {
      throw new Error(`copyDirAbsolute: unsupported entry type: ${src}`);
    }
  }
}
