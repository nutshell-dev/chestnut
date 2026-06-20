import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 506: invariant that foundation/<module>/types.ts files exist as
 * sibling-direct ratify (phase 1312 D) — major foundation modules each
 * have a types.ts file that's allowed to be deep-imported.
 */
describe('foundation types.ts sibling-direct pattern (phase 506)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

  it.each([
    'foundation/fs/types.ts',
    'foundation/llm-provider/types.ts',
    'foundation/audit/types.ts',
    'foundation/messaging/types.ts',
    'foundation/tools/types.ts',
  ])('%s exists (sibling-direct ratify target)', (rel) => {
    const cmd = `test -f ${srcRoot}/${rel} && echo OK || echo MISS`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('OK');
  });
});
