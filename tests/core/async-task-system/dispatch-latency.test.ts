/**
 * Phase 1147 r127 B fork: dispatch latency invariant.
 *
 * Reverse test (latency floor): AsyncTaskSystem must use chokidar's
 * `stability: 'immediate'` mode so pending → ingest happens on the native
 * `add` event (not after a stabilityThreshold wait).
 *   - BEFORE revert ('stable'): ≥ 100ms (chokidar awaitWriteFinish settle)
 *   - AFTER revert ('immediate'): native fire, no settle
 *
 * Phase 1199 γ1 replaced the original wall-clock timing test with a
 * grep-based structural invariant (mirror phase 964 silent-x-invariant).
 *
 * Phase 1402 deleted the `atomic write invariant: non-.json files ignored`
 * sibling test: it depended on real FSEvents delivery within a 10s magic
 * timeout, was flaky under heavy parallel CI load, and did not actually
 * assert the negative ("ignored") branch it advertised.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

describe('AsyncTaskSystem dispatch latency (phase 1147 r127 B fork)', () => {
  it('AsyncTaskSystem 用 stability=immediate (regression guard for phase 1147 revert)', () => {
    const __filename = fileURLToPath(import.meta.url);
    // phase 16 Step A: watcher 拆出 pending-watcher.ts、stability 字符串随之迁移
    const watcherSrcPath = path.resolve(path.dirname(__filename), '../../../src/core/async-task-system/pending-watcher.ts');
    const src = readFileSync(watcherSrcPath, 'utf-8');
    expect(src).toMatch(/stability:\s*['"]immediate['"]/);
  });
});
