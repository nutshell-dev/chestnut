import { afterAll } from 'vitest';
import { getTrackedDirs } from '../tests/utils/temp.js';
import { inspectRetention } from '../tests/utils/resource-retention.js';

afterAll(() => {
  const remaining = [...getTrackedDirs()];
  if (remaining.length === 0) return;
  const runRoot = process.env.CHESTNUT_RUN_ROOT;
  const preserved: string[] = [];
  const indeterminate: string[] = [];
  const leaks: string[] = [];
  for (const dir of remaining) {
    const decision = runRoot ? inspectRetention(runRoot, dir) : { kind: 'allow' as const };
    if (decision.kind === 'preserve') {
      preserved.push(
        `${dir} scopes=${decision.scopeIds.join(',') || 'legacy'} reasons=${decision.reasons.join(',')}`,
      );
    } else if (decision.kind === 'indeterminate') {
      indeterminate.push(`${dir}: ${String(decision.error)}`);
    } else {
      leaks.push(dir);
    }
  }
  if (preserved.length > 0) {
    console.warn(`[temp-retention] explained retained temp dirs:\n  ${preserved.join('\n  ')}`);
  }
  if (indeterminate.length > 0) {
    throw new Error(`[temp-retention] cannot inspect tracked temp dirs:\n  ${indeterminate.join('\n  ')}`);
  }
  if (leaks.length > 0) {
    const msg = `[temp-leak] ${leaks.length} unexplained tracked temp dirs not cleaned up:\n  ${leaks.join('\n  ')}`;
    if (process.env.CHESTNUT_KEEP_TEST_TMP === '1') {
      console.warn(msg);
      console.warn('[temp-leak] CHESTNUT_KEEP_TEST_TMP=1, preserving dirs for inspection');
    } else {
      throw new Error(msg);
    }
  }
});
