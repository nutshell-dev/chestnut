import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 502: ratchet test ensuring no "L0" string appears in src/.
 *
 * phase 441 user clarified: L0 is a doc/spec-only concept, not allowed
 * in code. phase 441 removed the only L0 literal (src/constants.ts:4
 * "L0 shared constants only" comment).
 *
 * This ratchet prevents regression.
 */
describe('no L0 in src ratchet (phase 502)', () => {
  it('no L0 word-boundary string appears in src/', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rnE "\\bL0\\b" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });
});
