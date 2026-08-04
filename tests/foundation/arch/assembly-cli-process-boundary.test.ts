/**
 * Phase 1281 Step A: Assembly→CLIProcess 边界 ratchet。
 *
 * Phase 1281 删除 CLI_FILE_ROUTING 伪贡献后，Assembly 对 CLIProcess（src/cli/**）
 * 仅剩一条白名单边：
 *
 *   src/assembly/config/compose-config.ts
 *     -> src/cli/commands/chat-viewport/config-schema.js（viewportConfigSchema）
 *
 * scanner 解析 src/assembly/** 的静态 import/export 与动态 import() specifier，
 * 相对路径解析后落入 src/cli/ 即记录为边；白名单精确到文件级，不按整个
 * cli/commands 目录放行。CLIProtocol（src/cli-protocol/）路径必须被区分，
 * 不得误算为 CLIProcess。正反 fixture 自证，避免只对当前源码做脆弱 grep。
 * scanner 原语复用 cli-guidance-boundary-helpers.js。
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

/** 唯一允许的 Assembly→CLIProcess 边（相对 PROJECT_ROOT 展示，扩展名剥离后比较）。 */
const ALLOWED_EDGES: ReadonlyArray<{ file: string; target: string }> = [
  {
    file: path.join('src', 'assembly', 'config', 'compose-config.ts'),
    target: path.join('src', 'cli', 'commands', 'chat-viewport', 'config-schema'),
  },
];

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

/** 剥离 .js/.ts 扩展名，供与白名单做模块级比较。 */
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

describe('phase 1281 Step A: Assembly→CLIProcess 边界（唯一边 = viewportConfigSchema）', () => {
  it('Assembly 对 CLIProcess 的 import 恰为白名单唯一边', () => {
    expect(collectCliEdges(assemblyDir())).toEqual([...ALLOWED_EDGES]);
  });

  it('白名单按文件精确匹配，不放行整个 cli/commands 目录', () => {
    // 合成反例：同一目录下的其他 CLI 模块（如 viewport-audit-events）不在白名单
    const sibling = path.join('src', 'cli', 'commands', 'viewport-audit-events');
    expect(ALLOWED_EDGES.some(e => e.target === sibling)).toBe(false);
    expect(ALLOWED_EDGES.every(e => e.file.endsWith(path.join('config', 'compose-config.ts')))).toBe(true);
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
