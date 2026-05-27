import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Tools — readonly + supportsAsync mutex invariant (P1.12 / β reframe)', () => {
  it('no NEW tool has both readonly===true and supportsAsync===true (baseline=2 known)', () => {
    const srcDir = path.resolve(__dirname, '../../../src');
    const files = collectTsFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      // Heuristic: both properties present in the same file
      if (content.includes('readonly: true') && content.includes('supportsAsync: true')) {
        // Verify they appear close enough to be the same tool definition
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (/readonly:\s*true/.test(lines[i])) {
            const nearby = lines.slice(i, Math.min(lines.length, i + 8)).join('\n');
            if (/supportsAsync:\s*true/.test(nearby)) {
              const rel = path.relative(srcDir, file);
              if (!violations.includes(rel)) violations.push(rel);
            }
          }
        }
      }
    }

    // Known existing violations (documented technical debt):
    // - search 和 memory_search 同时支持 readonly + async，尚未整改
    const known = [
      'foundation/file-tool/search.ts',
      'core/memory/tools/memory_search.ts',
    ];
    const unknown = violations.filter(v => !known.some(k => v.endsWith(k)));
    expect(unknown).toEqual([]);
  });
});

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}
