import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('fs/node-fs.ts: writeAtomicSync uses IGNORE_PATTERN', () => {
  it('does not contain hardcoded .tmp_ literal in writeAtomicSync', () => {
    const src = readFileSync('src/foundation/fs/node-fs.ts', 'utf-8');
    // Allow IGNORE_PATTERN definition in atomic.ts, but node-fs.ts should reference the constant
    expect(src).not.toMatch(/`\.tmp_\$\{randomUUID\(\)\}`/);
    expect(src).not.toMatch(/"\.tmp_"\+randomUUID/);
    expect(src).not.toMatch(/'\.tmp_'\+randomUUID/);
    expect(src).not.toMatch(/\.tmp_\$\{randomUUID\(\)\}/);
  });

  it('imports IGNORE_PATTERN from atomic.js', () => {
    const src = readFileSync('src/foundation/fs/node-fs.ts', 'utf-8');
    expect(src).toMatch(/IGNORE_PATTERN/);
  });

  it('uses IGNORE_PATTERN in tmp file naming', () => {
    const src = readFileSync('src/foundation/fs/node-fs.ts', 'utf-8');
    expect(src).toMatch(/\$\{IGNORE_PATTERN\}\$\{randomUUID\(\)\}/);
  });
});
