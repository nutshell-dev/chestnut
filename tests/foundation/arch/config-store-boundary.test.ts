/**
 * Phase 1297 Step C/D: ConfigStore 物理边界 ratchet。
 *
 * 冻结三条 module invariant：
 * 1. 物理归属：旧位置 src/assembly/config/config-loader.ts 消失，
 *    实现位于 src/foundation/config-store/store.ts；
 * 2. 依赖方向：ConfigStore production import 只允许 bare package（含 Node
 *    builtin）、模块内部相对路径与 foundation/fs barrel；
 * 3. 零上层业务符号：ConfigStore 源码（含注释）不出现
 *    assembly|root|claw|watchdog|audit|llm 文本。
 *
 * caller/barrel 表面 invariant 归 config-store-public-surface.test.ts。
 * scanner 均带反向 fixture 自证（不是恒真断言）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkTsFiles } from './cli-guidance-boundary-helpers.js';
import {
  PROJECT_ROOT,
  CONFIG_STORE_DIR,
  FS_BARREL,
  OLD_LOADER_PATH,
  stripExtension,
  collectRelativeImportEdges,
} from './config-store-boundary-helpers.js';

const BUSINESS_TOKEN_RE = /assembly|root|claw|watchdog|audit|llm/i;

/**
 * ConfigStore 内部文件的一条相对 import 是否合法：
 * 只允许模块内部文件（./store.js、./errors.js）与 FileSystem barrel。
 */
function isAllowedConfigStoreRelative(resolved: string): boolean {
  if ((resolved + path.sep).startsWith(CONFIG_STORE_DIR + path.sep)) return true;
  if (resolved === CONFIG_STORE_DIR) return true;
  return stripExtension(resolved) === FS_BARREL;
}

describe('phase 1297: ConfigStore 物理归属', () => {
  it('旧位置 config-loader.ts 消失、实现位于 ConfigStore', () => {
    expect(fs.existsSync(OLD_LOADER_PATH)).toBe(false);
    expect(fs.existsSync(path.join(CONFIG_STORE_DIR, 'store.ts'))).toBe(true);
    expect(fs.existsSync(path.join(CONFIG_STORE_DIR, 'errors.ts'))).toBe(true);
    expect(fs.existsSync(path.join(CONFIG_STORE_DIR, 'index.ts'))).toBe(true);
  });
});

describe('phase 1297: ConfigStore 依赖方向', () => {
  it('production 相对 import 只允许模块内部与 foundation/fs barrel', () => {
    const edges = collectRelativeImportEdges(CONFIG_STORE_DIR);
    const violations = edges.filter((e) => !isAllowedConfigStoreRelative(e.resolved));
    expect(violations).toEqual([]);
  });

  it('正向自证：确实消费 foundation/fs barrel 且存在模块内部边（scanner 非恒真）', () => {
    const edges = collectRelativeImportEdges(CONFIG_STORE_DIR);
    expect(edges.some((e) => stripExtension(e.resolved) === FS_BARREL)).toBe(true);
    expect(edges.some((e) =>
      (e.resolved + path.sep).startsWith(CONFIG_STORE_DIR + path.sep),
    )).toBe(true);
  });

  it('反向 fixture：指向 ConfigStore 外的相对 import 必须被判定违规', () => {
    const fakeFile = path.join(CONFIG_STORE_DIR, 'store.ts');
    const dir = path.dirname(fakeFile);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, '../../assembly/config/config-load.js'))).toBe(false);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, '../node-utils/index.js'))).toBe(false);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, '../fs/index.js'))).toBe(true);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, './errors.js'))).toBe(true);
  });
});

describe('phase 1297: ConfigStore 零上层业务符号', () => {
  it('源码（含注释）不出现 assembly|root|claw|watchdog|audit|llm', () => {
    const hits: string[] = [];
    for (const file of walkTsFiles(CONFIG_STORE_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (BUSINESS_TOKEN_RE.test(line)) {
          hits.push(`${path.relative(PROJECT_ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('反向 fixture：业务符号样例必须被 token 正则命中', () => {
    expect(BUSINESS_TOKEN_RE.test('caller 决定 root config 文案')).toBe(true);
    expect(BUSINESS_TOKEN_RE.test('L6 Assembly')).toBe(true);
    expect(BUSINESS_TOKEN_RE.test('patch llm.primary')).toBe(true);
    expect(BUSINESS_TOKEN_RE.test('schema 参数化的 generic persistence')).toBe(false);
  });
});
