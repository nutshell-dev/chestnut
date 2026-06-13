import { readFile } from 'node:fs/promises';
import { WAIT_FOR_DEFAULT_BUDGET_MS } from './test-timeouts.js';

/**
 * Poll interval for fs.readFile retries inside waitForCompleteFile.
 * Derivation: > WAIT_FOR_DEFAULT_POLL_MS (10ms, used for purely in-memory predicates)
 * because fs.readFile + regex test 触发 syscall + IO，每次 poll 实际开销远大于 nextTick.
 */
const WAIT_FOR_FILE_POLL_MS = 20;

/**
 * Poll a file until its content matches a regex or timeout.
 * Used for waiting on atomic rename completion in tests.
 */
export async function waitForCompleteFile(
  path: string,
  regex: RegExp,
  timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(path, 'utf-8');
      if (regex.test(content)) return content;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await new Promise(r => setTimeout(r, WAIT_FOR_FILE_POLL_MS));
  }
  throw new Error(`waitForCompleteFile timeout: ${path} did not match ${regex} in ${timeoutMs}ms`);
}
