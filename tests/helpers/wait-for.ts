/**
 * Poll until condition returns true or timeout.
 * Supports both sync and async predicates.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  const base = `waitFor timed out after ${timeoutMs}ms`;
  const msg = lastError instanceof Error
    ? `${base} (last predicate error: ${lastError.message})`
    : base;
  throw new Error(msg);
}
