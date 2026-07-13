/**
 * Phase 948 site A — exec maxBuffer SIGTERM 后 pushChunk early return
 *
 * Verifies that after maxBuffer triggers SIGTERM, no additional chunks
 * are pushed into buffers during the grace period.
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';

import { exec, ProcessExecError } from '../../../src/foundation/process-exec/index.js';

describe('exec maxBuffer SIGTERM 后 pushChunk early return (phase 948 site A)', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = tmpdir();
  const MAX_BUFFER = 1024 * 1024; // 1MB, mirror internal PROCESS_EXEC_MAX_BUFFER

  it('SIGTERM 触发后 grace period 内 buffers 不再 push', async () => {
    // Node script that ignores SIGTERM and writes rapidly to stdout
    // using drain-based backpressure to avoid tight-loop blocking.
    // Without the early-return guard, the 1000ms grace period would allow
    // many additional chunks to accumulate in buffers after SIGTERM.
    const script = `
      process.on('SIGTERM', () => {});
      const chunk = 'x'.repeat(65536);
      function writeLoop() {
        while (process.stdout.write(chunk)) {}
        process.stdout.once('drain', writeLoop);
      }
      writeLoop();
    `;

    try {
      // phase 999 r121 P fork C.G.1: timeout 30000 → 10000 (typical runtime ~2-3s + 3-4x margin)
      await exec('node', ['-e', script], { cwd: workDir, timeout: 10000 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      const error = err as ProcessExecError;
      expect(error.maxBufferExceeded).toBe(true);
      // With the guard, output should stay close to MAX_BUFFER.
      // Without it, the 1000ms grace period could add many MBs.
      expect(error.output.length).toBeLessThanOrEqual(MAX_BUFFER + 65536 * 5);
    }
  }, 10000);
});
