import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * cross-claw 直拼模式（应经 ClawTopology API）
 *
 * 抓：
 * - path.join(...clawsDir..., ...clawId...)
 * - path.join(...CLAWS_DIR..., ...<some>Id...)
 * - enumerateClaws( ... ) 直调
 *
 * 业务层（src/core/）禁直拼、应经 topology.read / topology.resolve / topology.enumerate API。
 *
 * 白名单（path-based、ML 元约束泛化）：
 * - src/core/claw-topology/* （拓扑业务 own 模块、自己 own）
 *
 * 防 regression 抓范围：
 * - src/core/**（业务层）
 * - src/cli/commands/chat-viewport-claw-manager.ts、chat-viewport-claw-panel.ts、chat-viewport-commands.ts（phase 260 cascade、防 regression）
 *
 * 不抓（by-design）：
 * - src/foundation/**（primitive 层、phase 238 ratify foundation 单源）
 * - src/assembly/**（L6 装配协议、phase 84/98 ratify）
 * - src/cli/**（除 cascade 3 file 外、CLI 命令装配派生 by-design）
 */

const SCAN_DIRS_AND_FILES: string[] = [
  'src/core',
  'src/cli/commands/chat-viewport-claw-manager.ts',
  'src/cli/commands/chat-viewport-claw-panel.ts',
  'src/cli/commands/chat-viewport-commands.ts',
];

const WHITELIST_PATH_PREFIXES: string[] = [
  'src/core/claw-topology/',
];

const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // path.join(...clawsDir..., ...clawId...)
  {
    name: 'path.join(clawsDir, clawId, ...)',
    re: /\bpath\.join\([^)]*\bclawsDir\b[^)]*,[^)]*\bclawId\b/,
  },
  // path.join(...CLAWS_DIR..., ...<Id>...)
  {
    name: 'path.join(CLAWS_DIR, <id>, ...)',
    re: /\bpath\.join\([^)]*\bCLAWS_DIR\b[^)]*,[^)]*\b[a-zA-Z]+Id\b/,
  },
  // enumerateClaws( 直调
  {
    name: 'enumerateClaws( ... )',
    re: /\benumerateClaws\s*\(/,
  },
];

function isWhitelisted(relPath: string): boolean {
  return WHITELIST_PATH_PREFIXES.some(prefix => relPath.startsWith(prefix));
}

function collectTsFiles(entry: string): string[] {
  const abs = path.join(REPO_ROOT, entry);
  const stats = fs.statSync(abs);
  if (stats.isDirectory()) {
    const results: string[] = [];
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      const child = path.posix.join(entry, e.name);
      if (e.isDirectory()) {
        results.push(...collectTsFiles(child));
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        results.push(child);
      }
    }
    return results;
  }
  return [entry];
}

function collectFilesToScan(): string[] {
  const files: string[] = [];
  for (const entry of SCAN_DIRS_AND_FILES) {
    files.push(...collectTsFiles(entry));
  }
  return files;
}

describe('cross-claw must go via ClawTopology', () => {
  it('业务层 + 已 cascade 子模块禁直拼 cross-claw path / 禁直调 enumerateClaws', () => {
    const files = collectFilesToScan();
    const violations: Array<{ file: string; pattern: string; lineNo: number; line: string }> = [];

    for (const relPath of files) {
      if (isWhitelisted(relPath)) continue;
      const abs = path.join(REPO_ROOT, relPath);
      const src = fs.readFileSync(abs, 'utf-8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const { name, re } of FORBIDDEN_PATTERNS) {
          if (re.test(lines[i])) {
            violations.push({ file: relPath, pattern: name, lineNo: i + 1, line: lines[i].trim() });
          }
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map(v => `  ${v.file}:${v.lineNo} [${v.pattern}]\n    ${v.line}`)
        .join('\n');
      throw new Error(
        `Cross-claw direct path detected (${violations.length} violations).\n` +
        `Business modules must go via ClawTopology API:\n` +
        `  - topology.read(clawId, relPath)\n` +
        `  - topology.resolve(clawId).clawDir\n` +
        `  - topology.enumerate()\n\n` +
        `Whitelisted paths (own/primitive layers):\n${WHITELIST_PATH_PREFIXES.map(p => `  - ${p}`).join('\n')}\n\n` +
        `Violations:\n${detail}`,
      );
    }
  });
});
