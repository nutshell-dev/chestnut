/**
 * phase 313 invariant: business state write 必经 atomic write
 *
 * 应然：DP1「中断可恢复」+ DP4「磁盘即权威」推 business state write 必经 atomic write
 *   (FileSystem.writeAtomic / writeAtomicSync / writeExclusiveSync)、否则 power loss / OS crash 时半写状态 →
 *   重启 corrupted。
 *
 * 测策略：grep + baseline allow-list（mirror phase 117 + phase 1395 pattern）、扫 src/ 全集
 * raw write call sites（fs.writeFileSync / fs.writeSync / nodeFs.writeFileSync）、白名单 boundary
 * 例外（audit/writer.ts audit-of-audit recursion border、phase 586 ratify）。
 *
 * NEW PR raw write 命中 → fail + 报错引 phase 313 anchor + suggest writeAtomic 替换。
 *
 * Phase 313 SOT（V9 (a) 真治、撤回 phase 306 (C) ratify）、详 `coding plan/phase313/`。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');

// Raw write patterns that violate the atomic-write SOT.
const RAW_WRITE_PATTERN = /\b(?:nodeFs|fs)\.(?:writeFileSync|writeSync)\b/g;

// Atomic write APIs that are the required way to persist critical state.
const ATOMIC_WRITE_PATTERN = /\b(?:writeAtomic|writeAtomicSync|writeExclusiveSync)\b/g;

// Boundary exceptions allow-list. Each entry must carry an explicit phase ratify
// anchor comment explaining why direct nodeFs/fs write is unavoidable.
const BOUNDARY_ALLOWLIST = new Set([
  // phase 586: audit-of-audit recursion border — audit writer fallback must write
  // directly via nodeFs to avoid recursively triggering the atomic-write audit path
  // when the audit system itself is the caller.
  'src/foundation/audit/writer.ts',
]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (stat.isFile() && entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Strip TypeScript comments and string literals so that mechanical grep does not
 * flag examples inside documentation or test fixtures.
 *
 * Mirrors the pragmatic lexer-free approach used by tests/design/* invariants.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`(?:\\`|[^`])*`/g, ' ')
    .replace(/'(?:\\'|[^'])*'/g, ' ')
    .replace(/"(?:\\"|[^"])*"/g, ' ');
}

describe('phase 313: business state write 必经 atomic write invariant', () => {
  const files = walk(SRC_ROOT);

  it('raw write call sites must be in boundary allowlist or use atomic API', () => {
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const cleaned = stripCommentsAndStrings(content);
      const matches = cleaned.match(RAW_WRITE_PATTERN);
      if (matches && matches.length > 0) {
        const relPath = path.relative(PROJECT_ROOT, file);
        if (!BOUNDARY_ALLOWLIST.has(relPath)) {
          violations.push(
            `${relPath}: ${matches.length} raw write site(s) — 应用 FileSystem.writeAtomic / writeAtomicSync / writeExclusiveSync；` +
              `若属 boundary 例外、加入 BOUNDARY_ALLOWLIST + 引 phase ratify anchor`,
          );
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `phase 313 invariant 违反 — business state write 必经 atomic write\n` +
          `（DP1「中断可恢复」+ DP4「磁盘即权威」+ ML#9「优先表达让编译器检查」）:\n\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          `\n\n详 'coding plan/phase313/' + 'design/modules/drift-backlog/l2_audit_log.md' phase 313 row`,
      );
    }
  });

  it('boundary allowlist covers expected exceptions (audit/writer.ts)', () => {
    expect(BOUNDARY_ALLOWLIST.has('src/foundation/audit/writer.ts')).toBe(true);
  });

  it('atomic write API call sites are present (≥40)', () => {
    let totalAtomicSites = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const matches = content.match(ATOMIC_WRITE_PATTERN);
      if (matches) {
        totalAtomicSites += matches.length;
      }
    }

    expect(totalAtomicSites).toBeGreaterThanOrEqual(40);
  });
});
