/**
 * Phase 1283 Step B: Assembly→CLIProcess 零边 ratchet。
 *
 * Phase 1283 Step A 将 viewportConfigSchema 归位 CLIProtocol 后，Assembly 对
 * CLIProcess（src/cli/**）的 production 直接边归零；本 ratchet 将 Phase 1281 的
 * 「唯一允许一条边」白名单升级为 production 零边断言，与 dependency-cruiser
 * `no-assembly-to-cli-process` 通用规则（同 phase 立）双保险。
 *
 * scanner 解析 src/assembly/** 的静态 import/export 与动态 import() specifier，
 * 相对路径解析后落入 src/cli/ 即记录为边。CLIProtocol（src/cli-protocol/）路径
 * 必须被区分，不得误算为 CLIProcess。正反 fixture 自证，避免只对当前源码做脆弱
 * grep。scanner 原语复用 cli-guidance-boundary-helpers.js。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IMPORT_SPECIFIER_RE,
  assemblyDir,
  walkTsFiles,
} from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const CLI_DIR = path.join(SRC_ROOT, 'cli') + path.sep;
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** 动态 import('...') 的 specifier（global flag：只供 matchAll 使用）。 */
const DYNAMIC_IMPORT_SPECIFIER_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

interface CliEdge {
  /** PROJECT_ROOT 相对路径的 import 方文件。 */
  file: string;
  /** 解析到 src/cli/ 下的目标（PROJECT_ROOT 相对，扩展名剥离）。 */
  target: string;
}

/** resolved 绝对路径是否落入 CLIProcess（src/cli/）；CLIProtocol 等兄弟目录不算。 */
function isCliProcessPath(resolved: string): boolean {
  return (resolved + path.sep).startsWith(CLI_DIR);
}

/** 剥离 .js/.ts 扩展名，供模块级比较。 */
function stripExtension(p: string): string {
  return p.replace(/\.(js|ts)$/, '');
}

/**
 * 扫描 dir 下 .ts 文件对 CLIProcess 的依赖：静态 import/export from 与动态
 * import() 的相对 specifier 解析后落入 src/cli/ 即记录。返回违规边列表。
 */
function collectCliEdges(dir: string): CliEdge[] {
  const edges: CliEdge[] = [];
  for (const file of walkTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    const specifiers: string[] = [];
    for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) specifiers.push(m[1]);
    for (const m of text.matchAll(DYNAMIC_IMPORT_SPECIFIER_RE)) specifiers.push(m[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue; // bare specifier 不可能落入 src/cli
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!isCliProcessPath(resolved)) continue;
      edges.push({
        file: path.relative(PROJECT_ROOT, file),
        target: stripExtension(path.relative(PROJECT_ROOT, resolved)),
      });
    }
  }
  return edges;
}

describe('phase 1283 Step B: Assembly→CLIProcess 零边', () => {
  it('Assembly 对 CLIProcess 的 production import 为零边', () => {
    expect(collectCliEdges(assemblyDir())).toEqual([]);
  });

  it('CLIProtocol（src/cli-protocol/）路径不被误算为 CLIProcess', () => {
    expect(isCliProcessPath(path.join(SRC_ROOT, 'cli', 'audit-events.js'))).toBe(true);
    expect(isCliProcessPath(path.join(SRC_ROOT, 'cli-protocol', 'index.js'))).toBe(false);
  });

  it('scanner 正反 fixture 自证', () => {
    const hits = collectCliEdges(FIXTURES_DIR);
    expect(hits).toContainEqual({
      file: path.join('tests', 'foundation', 'arch', 'fixtures', 'assembly-cli-import-violation.ts'),
      target: path.join('src', 'cli', 'audit-events'),
    });
    // clean fixture（phase 1281 后真正零 CLI 边）不得被命中
    expect(hits.some(e => e.file.includes('assembly-viewport-routing-clean'))).toBe(false);
    // fixtures 中除违规 fixture 外无其他 CLI 边
    expect(hits.filter(e => !e.file.includes('assembly-cli-import-violation'))).toEqual([]);
  });
});
