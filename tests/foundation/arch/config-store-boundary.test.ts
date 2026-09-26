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
  PROCESS_EXEC_BARREL,
  NODE_UTILS_BARREL,
  OLD_LOADER_PATH,
  stripExtension,
  collectRelativeImportEdges,
} from './config-store-boundary-helpers.js';

// 词边界化（Phase 1912 Step G）：pollMs / rootConfig 等标识符内的子串不命中；
// 业务 token 作为独立词出现才判违规。
const BUSINESS_TOKEN_RE = /\b(?:assembly|root|claw|watchdog|audit|llm)\b/i;

/**
 * ConfigStore 内部文件的一条相对 import 是否合法：
 * 只允许模块内部文件（./store.js、./errors.js）与 foundation barrel
 * （fs；Phase 1911 起 lock 活性证明/claim token 显式 ratify 消费
 * process-exec 与 node-utils barrel，同为 L1/L2a 同层依赖）。
 */
function isAllowedConfigStoreRelative(resolved: string): boolean {
  if ((resolved + path.sep).startsWith(CONFIG_STORE_DIR + path.sep)) return true;
  if (resolved === CONFIG_STORE_DIR) return true;
  const stripped = stripExtension(resolved);
  return stripped === FS_BARREL || stripped === PROCESS_EXEC_BARREL || stripped === NODE_UTILS_BARREL;
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
  it('production 相对 import 只允许模块内部与 foundation fs/process-exec/node-utils barrel', () => {
    const edges = collectRelativeImportEdges(CONFIG_STORE_DIR);
    const violations = edges.filter((e) => !isAllowedConfigStoreRelative(e.resolved));
    expect(violations).toEqual([]);
  });

  it('正向自证：确实消费 foundation barrel 且存在模块内部边（scanner 非恒真）', () => {
    const edges = collectRelativeImportEdges(CONFIG_STORE_DIR);
    expect(edges.some((e) => stripExtension(e.resolved) === FS_BARREL)).toBe(true);
    expect(edges.some((e) => stripExtension(e.resolved) === PROCESS_EXEC_BARREL)).toBe(true);
    expect(edges.some((e) => stripExtension(e.resolved) === NODE_UTILS_BARREL)).toBe(true);
    expect(edges.some((e) =>
      (e.resolved + path.sep).startsWith(CONFIG_STORE_DIR + path.sep),
    )).toBe(true);
  });

  it('反向 fixture：指向 ConfigStore 外的相对 import 必须被判定违规', () => {
    const fakeFile = path.join(CONFIG_STORE_DIR, 'store.ts');
    const dir = path.dirname(fakeFile);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, '../../assembly/config/config-load.js'))).toBe(false);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, '../messaging/index.js'))).toBe(false);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, '../fs/index.js'))).toBe(true);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, '../process-exec/index.js'))).toBe(true);
    expect(isAllowedConfigStoreRelative(path.resolve(dir, '../node-utils/index.js'))).toBe(true);
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
    // Phase 1912 Step G：词边界化后标识符子串（pollMs/rootConfig）不再误报
    expect(BUSINESS_TOKEN_RE.test('pollMs: opts?.pollMs ?? CONFIG_LOCK_POLL_MS')).toBe(false);
    expect(BUSINESS_TOKEN_RE.test('rootConfig: Pick<RootConfigReader>')).toBe(false);
  });
});
