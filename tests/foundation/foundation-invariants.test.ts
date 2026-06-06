/**
 * foundation/ 域 grep-based invariant lint cluster
 *
 * phase 1395: merged from
 *   - no-business-role-in-foundation.test.ts (ML#5: 不持 business caller role literal)
 *   - no-reverse-audit-import.test.ts (phase 1278 α: AUDIT_PREVIEW_LEN 从 L0 import)
 *
 * 两者皆为 walk(src) + readFileSync regex 模式的 invariant lint，
 * 完全相同 import 结构，自然 cluster。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import path from 'node:path';

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (p.endsWith('.ts')) files.push(p);
  }
  return files;
}

const BUSINESS_ROLES = ['motion', 'claw', 'subagent', 'verifier', 'shadow', 'miner'];

// Pre-existing literals outside the 3-site scope of phase1254.
// These are tool-profile names / messaging defaults / config schemas,
// not caller-role definitions. They are recorded as technical debt
// for future phase r134+ assessment.
const ALLOW_LIST_FILES = new Set([
  'src/foundation/command-tool/exec.ts',
  'src/foundation/config/schemas.ts',
  'src/foundation/file-tool/edit.ts',
  'src/foundation/file-tool/ls.ts',
  'src/foundation/file-tool/multi_edit.ts',
  'src/foundation/file-tool/read.ts',
  'src/foundation/file-tool/search.ts',
  'src/foundation/file-tool/write.ts',
  'src/foundation/messaging/tools/notify-claw.ts',
  'src/foundation/messaging/tools/send.ts',
  'src/foundation/process-manager/agent-factory.ts',
  'src/foundation/process-manager/types.ts',
  'src/foundation/skill-system/tools/skill.ts',
  'src/foundation/tools/context.ts',
  'src/foundation/tools/executor.ts',
  'src/foundation/tools/types.ts',
]);

describe('foundation/ 域 ML#5 invariant: no business caller role literal', () => {
  it('foundation/tool-protocol/ 不持 quoted business role literal', () => {
    const targetFiles = [
      'src/foundation/tool-protocol/index.ts',
    ];
    for (const file of targetFiles) {
      const src = readFileSync(file, 'utf-8');
      for (const role of BUSINESS_ROLES) {
        const pattern = new RegExp(`['"\`]${role}['"\`]`);
        const m = src.match(pattern);
        if (m) {
          expect.fail(`foundation/ 持 business role literal '${role}' in ${file}: ${m[0]}`);
        }
      }
    }
  });

  it('foundation/tool-protocol/index.ts 不 re-export CallerType', () => {
    const src = readFileSync('src/foundation/tool-protocol/index.ts', 'utf-8');
    expect(src).not.toMatch(/export.*CallerType/);
    expect(src).not.toMatch(/export.*DispatchCallerType/);
    expect(src).not.toMatch(/export.*callerTypeToProfile/);
  });

  it('foundation/ 不 import from src/core/ (except caller-types migration)', () => {
    const files = walk('src/foundation');
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      const coreImports = src.match(/from\s+['"][^'"]*\/core\/[^'"]*['"]/g);
      if (coreImports) {
        const nonAllowed = coreImports.filter(
          (imp) => !imp.includes('caller-types')
        );
        if (nonAllowed.length > 0) {
          expect.fail(`${file} 不该 import from core/ (non-allowed: ${nonAllowed.join(', ')})`);
        }
      }
    }
  });

  it('foundation/ 无 NEW quoted business role literal (allow-list pre-existing)', () => {
    const files = walk('src/foundation').filter(f => !ALLOW_LIST_FILES.has(f));
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const role of BUSINESS_ROLES) {
        const pattern = new RegExp(`['"\`]${role}['"\`]`);
        const m = src.match(pattern);
        if (m) {
          expect.fail(`foundation/ NEW business role literal '${role}' in ${file}: ${m[0]}`);
        }
      }
    }
  });
});

describe('phase 1278 α: AUDIT_PREVIEW_LEN must not import from audit module', () => {
  it('no src/ file imports AUDIT_PREVIEW_LEN from audit barrel or audit/defaults', () => {
    const files = walk('src');
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      // Ban import of AUDIT_PREVIEW_LEN from any audit module path
      const bad = src.match(/import\s+.*AUDIT_PREVIEW_LEN.*from\s+['"][^'"]*audit[^'"]*['"]/g);
      if (bad) {
        violations.push(`${file}: ${bad.join(', ')}`);
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `AUDIT_PREVIEW_LEN must import from foundation/constants.js only. Violations:\n${violations.join('\n')}`,
      );
    }
  });

  it('AUDIT_PREVIEW_LEN is exported from foundation/constants.ts', () => {
    const src = readFileSync('src/foundation/constants.ts', 'utf-8');
    expect(src).toMatch(/export\s+const\s+AUDIT_PREVIEW_LEN\s*=\s*100/);
  });

  it('audit/defaults.ts re-exports from constants.js (backward-compat sunset)', () => {
    const src = readFileSync('src/foundation/audit/defaults.ts', 'utf-8');
    expect(src).toMatch(/export\s+\{\s*AUDIT_PREVIEW_LEN\s*\}\s+from\s+['"]\.\.\/constants\.js['"]/);
    expect(src).toMatch(/SUNSET/);
  });
});

describe('phase 1479: CLI verb fact schema must not live in foundation/', () => {
  // ML#5: foundation L1 不预设 L6 CLI verb / args / examples 这些上层概念。
  // phase 1477 错放 src/foundation/cli-help/、phase 1479 挪 src/cli/help/ 后立此 invariant 防回归。
  it('src/foundation/ has no file/dir named cli-help, verb-facts, or CLAW_VERB symbol', () => {
    const files = walk('src/foundation');
    const violations: string[] = [];
    for (const file of files) {
      if (file.includes('cli-help') || file.endsWith('verb-facts.ts')) {
        violations.push(`path: ${file}`);
        continue;
      }
      const src = readFileSync(file, 'utf-8');
      if (/\bCLAW_VERB_FACTS\b|\bCLAW_VERB_NAMES\b|\bVerbFact\b/.test(src)) {
        violations.push(`symbol in ${file}`);
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `foundation/ 不应持 CLI verb fact schema (ML#5 layering). Violations:\n${violations.join('\n')}`,
      );
    }
  });
});
