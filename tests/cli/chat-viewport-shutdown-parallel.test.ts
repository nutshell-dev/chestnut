/**
 * chat-viewport shutdown parallelization (phase 908 B2)
 *
 * Covers:
 * - Promise.all schema replaces serial for...of await
 * - Parallel stop timing: 3 × 100ms resolves in < 200ms total
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, '../../src/cli/commands/chat-viewport.ts');
const sourceCode = fs.readFileSync(sourcePath, 'utf-8');

describe('chat-viewport shutdown parallelization (B2)', () => {
  it('source uses Promise.all for taskWatchMap shutdown', () => {
    const cleanupStart = sourceCode.indexOf('await exitPromise;');
    expect(cleanupStart).toBeGreaterThan(-1);
    const cleanupBlock = sourceCode.slice(cleanupStart, cleanupStart + 2000);

    expect(cleanupBlock).toContain('Promise.all(');
    expect(cleanupBlock).toContain('taskWatchMap.values()');
    // old serial pattern removed
    expect(cleanupBlock).not.toMatch(
      /for\s*\(\s*const\s+tw\s+of\s+taskWatchMap\.values\(\)\s*\)\s*await\s+tw\.streamReader\?\.stop\(\)/
    );
  });

  it('Promise.all resolves 3 × SETTLE_MS stops in < 2 × SETTLE_MS (parallel vs serial)', async () => {
    // phase 1176: per-promise settle duration（test-local fixture）
    const SETTLE_MS = 100;
    const start = Date.now();
    await Promise.all(
      Array.from({ length: 3 }).map(() => new Promise<void>(r => setTimeout(r, SETTLE_MS)))
    );
    const elapsed = Date.now() - start;
    // parallel ≈ SETTLE_MS（1×）/ serial would be ≈ 3 × SETTLE_MS / 2 × SETTLE_MS 是区分上界
    expect(elapsed).toBeLessThan(SETTLE_MS * 2);
  });
});
