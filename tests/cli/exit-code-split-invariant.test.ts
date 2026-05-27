/**
 * Phase 1230 B-1 E.1 γ — CLI exit code split invariant lint test
 *
 * Covers:
 *   process.exit() 仅在 3 类边界 site 允许 (spawn re-entry / stdout drain / daemonized spawn)
 *   process.exitCode = N 在普通 command path 允许
 *   反向：synthetic violation detection
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_PROCESS_EXIT_SITES = new Set([
  'src/cli/with-cli-error-handling.ts',
  'src/cli/commands/chat-viewport-init.ts',
  'src/cli/commands/subagent-steps.ts',
]);

function globTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...globTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('CLI exit code split invariant (phase 1230 E.1 γ ratify)', () => {
  it('process.exit() 仅在 3 类边界 site (spawn re-entry / stdout drain / daemonized spawn)', () => {
    const files = globTsFiles('src/cli');
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      // Match process.exit( with optional whitespace
      if (/process\.exit\s*\(/.test(content) && !ALLOWED_PROCESS_EXIT_SITES.has(file)) {
        violations.push(file);
      }
    }
    expect(violations, `process.exit() found outside allowlist: ${violations.join(', ')}`).toEqual([]);
  });

  it('反向 1: synthetic NEW process.exit() in normal cmd → would be caught', () => {
    const syntheticBadFile = 'src/cli/commands/fake-cmd.ts';
    const syntheticContent = 'process.exit(1);';
    const isAllowed = ALLOWED_PROCESS_EXIT_SITES.has(syntheticBadFile);
    const hasExit = /process\.exit\s*\(/.test(syntheticContent);
    expect(isAllowed).toBe(false);
    expect(hasExit).toBe(true);
  });

  it('反向 2: allowlist 删除 → 3 边界 site 立 catch', () => {
    const emptyAllowlist = new Set<string>();
    const boundaryFiles = [
      'src/cli/with-cli-error-handling.ts',
      'src/cli/commands/chat-viewport-init.ts',
      'src/cli/commands/subagent-steps.ts',
    ];
    for (const file of boundaryFiles) {
      const content = readFileSync(file, 'utf-8');
      const hasExit = /process\.exit\s*\(/.test(content);
      expect(hasExit).toBe(true);
      expect(emptyAllowlist.has(file)).toBe(false);
    }
  });

  it('反向 3: with-cli-error-handling.ts wrapper 内 process.exit 替为 exitCode= → spawn bug regression', () => {
    const content = readFileSync('src/cli/with-cli-error-handling.ts', 'utf-8');
    // Verify the file uses process.exit(code) not just process.exitCode = code
    expect(content).toContain('process.exit(code)');
    // Verify the design comment explaining spawn-based fix is present
    expect(content).toContain('Explicit `process.exit(code)`');
  });
});
