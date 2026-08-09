/**
 * Phase 1284 Step B: Daemon entry resolver owner/consumer 边界 ratchet。
 *
 * Phase 1284 Step A 将 resolveDaemonEntry 自 Assembly 归位 Daemon 真 owner
 * （src/daemon/entry-resolver.ts）后，本 ratchet 冻结：
 *  - production 定义恰一处且在 daemon/entry-resolver.ts；
 *  - consumer 全部经 Daemon 单一 public barrel，当前集合显式登记；
 *  - resolver 零参数签名、不 import fs/Assembly/Daemon 运行实现；
 *  - assembly/spawn-entry.ts 已物理删除（phase 1285 归位 Watchdog 后 Assembly 零残留）。
 * 正反 fixture 自证 scanner 能识别旧 Assembly import 与合法 Daemon stable path。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMPORT_SPECIFIER_RE, assemblyDir, walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ENTRY_RESOLVER = path.join(SRC_ROOT, 'daemon', 'entry-resolver.ts');
const SPAWN_ENTRY = path.join(SRC_ROOT, 'assembly', 'spawn-entry.ts');
const STABLE_SUFFIX = 'daemon/index.js';

/** 完整 import 语句的 clause + specifier（global flag：只供 matchAll 使用）。 */
const IMPORT_CLAUSE_RE = /import\s+(?:type\s+)?([^'"]*?)\s+from\s+['"]([^'"]+)['"]/g;
const DEFINITION_RE = /export\s+function\s+resolveDaemonEntry/;

interface ResolverImport {
  /** PROJECT_ROOT 相对路径的 import 方文件。 */
  file: string;
  specifier: string;
}

/** 扫描 dir 下 .ts 文件中 clause 含 resolveDaemonEntry 的 import。 */
function collectResolverImports(dir: string): ResolverImport[] {
  const out: ResolverImport[] = [];
  for (const file of walkTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_CLAUSE_RE)) {
      if (!m[1].includes('resolveDaemonEntry')) continue;
      out.push({ file: path.relative(PROJECT_ROOT, file), specifier: m[2] });
    }
  }
  return out;
}

/** dir 下定义 resolveDaemonEntry 的文件（PROJECT_ROOT 相对）。 */
function collectDefinitions(dir: string): string[] {
  return walkTsFiles(dir)
    .filter((f) => DEFINITION_RE.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(PROJECT_ROOT, f));
}

// phase 1284 当前 consumer 集合；合法新 caller 需显式更新本表。
const EXPECTED_CONSUMERS = [
  'src/cli/commands/claw-chat.ts',
  'src/cli/commands/claw-daemon.ts',
  'src/cli/commands/motion-daemon.ts',
  'src/cli/commands/motion.ts',
  'src/cli/commands/start.ts',
  'src/cli/commands/status.ts',
  'src/cli/commands/stop.ts',
  'src/watchdog/watchdog.ts',
];

describe('phase 1284 Step B: Daemon entry resolver 归属边界', () => {
  it('production resolveDaemonEntry 定义恰在 daemon/entry-resolver.ts 一处', () => {
    expect(collectDefinitions(SRC_ROOT)).toEqual(['src/daemon/entry-resolver.ts']);
  });

  it('consumer 全部经稳定子入口、集合显式锁定', () => {
    const imports = collectResolverImports(SRC_ROOT);
    expect(imports.map((i) => i.file).sort()).toEqual(EXPECTED_CONSUMERS);
    for (const i of imports) {
      expect(i.specifier.endsWith(STABLE_SUFFIX), `${i.file} must use public barrel`).toBe(true);
      expect(i.specifier).not.toContain('assembly/spawn-entry');
    }
  });

  it('resolver 零参数签名、只依赖 node 路径原语', () => {
    const text = fs.readFileSync(ENTRY_RESOLVER, 'utf8');
    expect(text).toMatch(/export function resolveDaemonEntry\(\)/);
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[1]);
    // 只允许 node builtin 路径原语；fs/Assembly/Daemon 运行实现均不得出现
    expect(specifiers.sort()).toEqual(['path', 'url']);
  });

  it('assembly/spawn-entry.ts 已物理删除（phase 1285 Assembly 零残留）', () => {
    expect(fs.existsSync(SPAWN_ENTRY)).toBe(false);
  });

  it('scanner 正反 fixture 自证', () => {
    const hits = collectResolverImports(FIXTURES_DIR);
    const violation = hits.find((h) => h.file.includes('daemon-entry-resolver-assembly-import-violation'));
    expect(violation?.specifier).toContain('assembly/spawn-entry');
    const clean = hits.find((h) => h.file.includes('daemon-entry-resolver-stable-path-clean'));
    expect(clean?.specifier.endsWith(STABLE_SUFFIX)).toBe(true);
    expect(clean?.specifier).not.toContain('assembly/spawn-entry');
  });
});
