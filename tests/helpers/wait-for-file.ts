import { readFile } from 'node:fs/promises';

/**
 * Poll a file until its content matches a regex or timeout.
 * Used for waiting on atomic rename completion in tests.
 */
export async function waitForCompleteFile(
  path: string,
  regex: RegExp,
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(path, 'utf-8');
      if (regex.test(content)) return content;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`waitForCompleteFile timeout: ${path} did not match ${regex} in ${timeoutMs}ms`);
}
