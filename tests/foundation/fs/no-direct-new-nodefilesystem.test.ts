import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

describe('foundation/fs: no direct `new NodeFileSystem` outside bootstrap (phase 1283)', () => {
  const BOOTSTRAP_ALLOWLIST = [
    'src/assembly/assemble.ts',
    'src/assembly/core-infrastructure.ts',
    'src/cli/index.ts',
    'src/daemon-entry.ts',
    'src/watchdog-entry.ts',
    'src/foundation/fs/',
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

  it('only bootstrap sites construct NodeFileSystem directly', () => {
    const violations = findTsFiles('src').filter(f => {
      const content = readFileSync(f, 'utf8');
      return content.includes('new NodeFileSystem');
    }).filter(f => !BOOTSTRAP_ALLOWLIST.some(a => f.startsWith(a)));

    expect(
      violations,
      `M#3+M#7 violation: ${violations.join('\n')}. Inject fsFactory instead.`
    ).toEqual([]);
  });
});
