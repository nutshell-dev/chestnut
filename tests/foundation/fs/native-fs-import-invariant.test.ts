import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

describe('foundation/fs: native fs import invariant (phase 1283 ML#3 lock)', () => {
  const ALLOWLIST = [
    'src/foundation/fs/',
    'src/foundation/audit/writer.ts',
    'src/foundation/process-exec/spawn-detached.ts',
  ];

  function findTsFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findTsFiles(full));
      } else if (entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
    return files;
  }

  it('no native fs import outside allowlist', () => {
    const violations = findTsFiles('src').filter(f => {
      const content = readFileSync(f, 'utf8');
      return /^import.*['"](node:)?fs['"]/m.test(content);
    }).filter(f => !ALLOWLIST.some(a => f.startsWith(a)));

    expect(violations, `ML#3 violation: ${violations.join('\n')}`).toEqual([]);
  });
});
