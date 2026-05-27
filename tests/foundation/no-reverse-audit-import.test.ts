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
