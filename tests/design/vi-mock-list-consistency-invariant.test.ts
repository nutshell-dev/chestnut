/**
 * phase 316 invariant: VI_MOCK_FILES list ↔ tests/ 真 vi.mock use site 一致性
 *
 * 应然：ML#9「不可消除耦合显式表达 / 优先表达让编译器检查」+ 编码规范测试
 *   「让代码经历从未走过的路径」推 vitest.config.ts VI_MOCK_FILES list 必与
 *   tests/ 全集 vi.mock 真 use site 一致 (cross-file static mock race 防漂前置条件)。
 *
 * 测策略：grep + Set diff (mirror phase 313 atomic-write invariant + phase 117/1395 baseline allowlist 模式)。
 *
 * NEW PR 加 vi.mock 但漏 update VI_MOCK_FILES → test fail、报错引 phase 316 + suggest add to list。
 * NEW PR 删 test file 或停 vi.mock 但 list 残留 → test fail、suggest remove from list。
 *
 * Phase 316 SOT (V53 a 真治、撤回 phase 306 (C) ratify「真治推 §10」)、详 `coding plan/phase316/`。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  INTEGRATION_PROCESS_FILES,
  INTEGRATION_IO_FILES,
  INFRA_FILES,
} from '../../.config/vitest.config.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

function walkTests(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTests(full, out);
    } else if (stat.isFile() && entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

/** Extract VI_MOCK_FILES list entries (only within `const VI_MOCK_FILES = [...]` block). */
function loadViMockList(): Set<string> {
  const configPath = path.join(REPO_ROOT, '.config/vitest.config.ts');
  const content = readFileSync(configPath, 'utf-8');
  const startIdx = content.indexOf('const VI_MOCK_FILES = [');
  if (startIdx === -1) {
    throw new Error('Could not find `const VI_MOCK_FILES = [` in .config/vitest.config.ts');
  }
  const endIdx = content.indexOf('];', startIdx);
  if (endIdx === -1) {
    throw new Error('Could not find closing `];` for VI_MOCK_FILES list');
  }
  const block = content.slice(startIdx, endIdx);
  const re = /^\s*'(tests\/[^']+)'/gm;
  const list = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    list.add(m[1]);
  }
  return list;
}

/** Detect if a test file has a top-level `vi.mock(...)` call (file-level static mock). */
const VI_MOCK_PATTERN = /^\s*vi\.mock\(/m;

function loadRealViMockUseSites(): Set<string> {
  const testsRoot = path.join(REPO_ROOT, 'tests');
  const files: string[] = [];
  walkTests(testsRoot, files);

  const real = new Set<string>();
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    if (VI_MOCK_PATTERN.test(content)) {
      const relPath = path.relative(REPO_ROOT, file);
      real.add(relPath);
    }
  }
  return real;
}

/**
 * phase 1006: OS-integration / infra projects run with isolate:true, so their
 * file-level vi.mock do not need to be listed in VI_MOCK_FILES (which guards
 * against cross-file static mock race in isolate:false projects).
 */
function matchesIntegrationPattern(file: string): boolean {
  const patterns = [
    ...INTEGRATION_PROCESS_FILES,
    ...INTEGRATION_IO_FILES,
    ...INFRA_FILES,
  ];
  return patterns.some(pattern => matchGlob(file, pattern));
}

function matchGlob(file: string, pattern: string): boolean {
  const fileParts = file.split('/');
  const patternParts = pattern.split('/');
  return matchParts(fileParts, patternParts);
}

function matchParts(fileParts: string[], patternParts: string[]): boolean {
  let f = 0;
  let p = 0;
  while (p < patternParts.length) {
    const pat = patternParts[p];
    if (pat === '**') {
      if (p === patternParts.length - 1) return true;
      const nextPat = patternParts[p + 1];
      while (f < fileParts.length) {
        if (matchSegment(fileParts[f], nextPat)) {
          if (matchParts(fileParts.slice(f + 1), patternParts.slice(p + 2))) {
            return true;
          }
        }
        f++;
      }
      return false;
    }
    if (f >= fileParts.length) return false;
    if (!matchSegment(fileParts[f], pat)) return false;
    f++;
    p++;
  }
  return f === fileParts.length;
}

function matchSegment(segment: string, pat: string): boolean {
  const re = new RegExp(
    '^' +
    pat
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<DOUBLESTAR>>>/g, '.*') +
    '$'
  );
  return re.test(segment);
}

describe('phase 316: VI_MOCK_FILES list ↔ tests/ vi.mock use site 一致性 invariant', () => {
  it('VI_MOCK_FILES list entries align with real vi.mock use sites', () => {
    const rawRealUseSites = loadRealViMockUseSites();
    // phase 1006: integration / infra projects run isolate:true and manage their
    // own vi.mock files, so they are exempt from the VI_MOCK_FILES list.
    const realUseSites = new Set(
      Array.from(rawRealUseSites).filter(f => !matchesIntegrationPattern(f)),
    );
    const listEntries = loadViMockList();

    const missingFromList: string[] = [];
    for (const real of realUseSites) {
      if (!listEntries.has(real)) missingFromList.push(real);
    }
    const staleInList: string[] = [];
    for (const listed of listEntries) {
      if (!realUseSites.has(listed)) staleInList.push(listed);
    }

    if (missingFromList.length > 0 || staleInList.length > 0) {
      missingFromList.sort();
      staleInList.sort();
      const parts: string[] = [
        `phase 316 invariant 违反 — VI_MOCK_FILES list ↔ tests/ vi.mock use site 漂`,
        `（ML#9「优先表达让编译器检查」+ 编码规范测试「让代码经历从未走过的路径」）:`,
        '',
      ];
      if (missingFromList.length > 0) {
        parts.push(`Missing from VI_MOCK_FILES (${missingFromList.length} entries to ADD):`);
        for (const f of missingFromList) parts.push(`  + '${f}',`);
        parts.push('');
      }
      if (staleInList.length > 0) {
        parts.push(`Stale in VI_MOCK_FILES (${staleInList.length} entries to REMOVE):`);
        for (const f of staleInList) parts.push(`  - '${f}',`);
        parts.push('');
      }
      parts.push(`Update .config/vitest.config.ts VI_MOCK_FILES list、保 commented-out 历史段不动。`);
      parts.push(`详 'coding plan/phase316/' + 'design/modules/drift-backlog/l2_audit_log.md' phase 316 row。`);
      throw new Error(parts.join('\n'));
    }
  });

  it('VI_MOCK_FILES list has ≥100 entries (sanity guard)', () => {
    const listEntries = loadViMockList();
    expect(listEntries.size).toBeGreaterThanOrEqual(100);
  });

  it('real vi.mock use sites have ≥100 entries (sanity guard)', () => {
    const realUseSites = loadRealViMockUseSites();
    expect(realUseSites.size).toBeGreaterThanOrEqual(100);
  });
});
