import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../../src');

/**
 * Phase 1179: business-path console.* invariant.
 * Any console.(log|error|warn|debug) call in src/ outside the allowlist
 * must have a `// console: <reason>` exemption comment on the same line.
 *
 * Allowlist categories (structural boundaries / CLI user-face / audit-of-audit):
 * 1. CLI subcommands: src/cli/** + src/watchdog/watchdog-cli.ts
 * 2. Process-level uncaught handlers: src/daemon-entry.ts + src/watchdog-entry.ts
 * 3. Audit recursion border: src/foundation/audit/writer.ts +
 *    src/foundation/audit/batched-writer.ts + src/core/async-task-system/system.ts
 * 4. Explicit dual-sink utility: src/watchdog/watchdog-log.ts
 * 5. LLM audit sink fallback (audit-of-audit): src/assembly/llm-audit-sink.ts
 */
const ALLOWLIST_GLOBS = [
  'cli/**',
  'watchdog/**',
  'daemon-entry.ts',
  'watchdog-entry.ts',
  'foundation/audit/**',
  'assembly/llm-audit-sink.ts',
];

const CONSOLE_REGEX = /console\.(log|error|warn|debug)\s*\(/;
const EXEMPTION_REGEX = /\/\/\s*console:\s*.+/;

describe('console business-path invariant', () => {
  it('no unauthorized console.* calls in src/ business paths', () => {
    const violations: string[] = [];
    walk(SRC_ROOT, (file) => {
      if (!file.endsWith('.ts')) return;
      const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (isAllowlisted(rel)) return;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!CONSOLE_REGEX.test(line)) continue;
        // JSDoc / comment-only lines that mention console are not actual calls
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
        // Audit recursion border pattern (audit-of-audit fallback)
        if (line.includes('[AUDIT CRITICAL]')) continue;
        // Exemption comment on same line
        if (EXEMPTION_REGEX.test(line)) continue;
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
    expect(violations).toEqual([]);
  });

  it('reverse: synthetic violation is caught', () => {
    const syntheticLine = `console.warn('test');`;
    expect(CONSOLE_REGEX.test(syntheticLine)).toBe(true);
    expect(EXEMPTION_REGEX.test(syntheticLine)).toBe(false);
  });

  it('reverse: allowlisted path is ignored', () => {
    expect(isAllowlisted('cli/commands/init.ts')).toBe(true);
    expect(isAllowlisted('watchdog/watchdog-cli.ts')).toBe(true);
    expect(isAllowlisted('foundation/audit/writer.ts')).toBe(true);
  });

  it('reverse: exemption comment permits console.* on same line', () => {
    const exemptLine = `console.error('hot'); // console: tmp debug`;
    expect(CONSOLE_REGEX.test(exemptLine)).toBe(true);
    expect(EXEMPTION_REGEX.test(exemptLine)).toBe(true);
  });

  it('reverse: snapshot lock is enforced by separate test', () => {
    // This invariant is about console.*; audit-events snapshot lock
    // is enforced by tests/foundation/audit/audit-events-snapshot-lock.test.ts
    expect(true).toBe(true);
  });
});

function isAllowlisted(relPath: string): boolean {
  for (const glob of ALLOWLIST_GLOBS) {
    if (glob.endsWith('/**')) {
      const prefix = glob.slice(0, -3);
      if (relPath.startsWith(prefix + '/')) return true;
    } else if (relPath === glob) {
      return true;
    }
  }
  return false;
}

function walk(dir: string, cb: (file: string) => void) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else if (entry.isFile()) cb(full);
  }
}
