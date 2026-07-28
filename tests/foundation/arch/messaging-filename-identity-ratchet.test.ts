/**
 * Phase 1230 ratchet: Messaging filenames must derive identity from a single
 * message UUID. The sequence counter resource is revoked and must not return.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const FORBIDDEN_RE = 'SequenceCounter|getSharedSequenceCounter|formatSeq|next-msg-seq';

describe('messaging filename identity ratchet (Phase 1230)', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');

  it('production code contains no sequence counter symbols', () => {
    const cmd = `grep -rEn '${FORBIDDEN_RE}' ${path.join(repoRoot, 'src')} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });

  it('tests contain no sequence counter symbols except this ratchet file', () => {
    const testRoot = path.join(repoRoot, 'tests');
    const cmd = `grep -rEn '${FORBIDDEN_RE}' ${testRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);
    const thisFile = path.basename(__filename);
    const offenders = lines.filter(line => !line.includes(thisFile));
    expect(offenders).toEqual([]);
  });
});
