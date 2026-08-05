/**
 * Phase 1297 Step D: ConfigStore arch ratchet 的共享扫描原语。
 *
 * 只为同目录 config-store-boundary / config-store-public-surface 两个
 * architecture invariant 服务：提供路径常量与 import scanner；验收决策
 * （expect/assertion、业务 token 正则、EXPECTED barrel 表面）全部留在
 * 各 .test.ts，本文件不含任何测试语义或生产语义。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IMPORT_SPECIFIER_RE,
  walkTsFiles,
} from './cli-guidance-boundary-helpers.js';

export const SRC_ROOT = path.join(__dirname, '..', '..', '..', 'src');
export const PROJECT_ROOT = path.join(SRC_ROOT, '..');
export const CONFIG_STORE_DIR = path.join(SRC_ROOT, 'foundation', 'config-store');
export const CONFIG_STORE_BARREL = path.join(CONFIG_STORE_DIR, 'index');
export const FS_BARREL = path.join(SRC_ROOT, 'foundation', 'fs', 'index');
export const OLD_LOADER_PATH = path.join(SRC_ROOT, 'assembly', 'config', 'config-loader.ts');

/** 剥离 .js/.ts 扩展名，供模块级比较。 */
export function stripExtension(p: string): string {
  return p.replace(/\.(js|ts)$/, '');
}

export interface ImportEdge {
  /** PROJECT_ROOT 相对路径的 import 方文件。 */
  file: string;
  specifier: string;
  /** 相对 specifier 解析后的绝对路径（未剥扩展名）。 */
  resolved: string;
}

/** 收集 dir 下 .ts 文件的相对 import/export specifier（静态）。 */
export function collectRelativeImportEdges(dir: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const file of walkTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = m[1];
      if (!specifier.startsWith('.')) continue;
      edges.push({
        file: path.relative(PROJECT_ROOT, file),
        specifier,
        resolved: path.resolve(path.dirname(file), specifier),
      });
    }
  }
  return edges;
}

/** 解析路径是否落入 ConfigStore 模块。 */
export function isInsideConfigStore(resolved: string): boolean {
  return (resolved + path.sep).startsWith(CONFIG_STORE_DIR + path.sep);
}
