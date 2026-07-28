/**
 * Phase 1230 ratchet: Messaging filenames must derive identity from a single
 * message UUID. The sequence counter resource is revoked and must not return.
 * InboxWriter async path must preserve caller-owned envelope identity.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const COUNTER_FORBIDDEN_RE = 'SequenceCounter|getSharedSequenceCounter|formatSeq|next-msg-seq';
const INBOX_REWRITE_FORBIDDEN_RE = 'extractMessageUuidFromId|UUID_V4_RE|\\.id = .*filenameUuid';

describe('messaging filename identity ratchet (Phase 1230)', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');

  it('production code contains no sequence counter symbols', () => {
    const cmd = `grep -rEn '${COUNTER_FORBIDDEN_RE}' ${path.join(repoRoot, 'src')} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });

  it('tests contain no sequence counter symbols except this ratchet file', () => {
    const testRoot = path.join(repoRoot, 'tests');
    const cmd = `grep -rEn '${COUNTER_FORBIDDEN_RE}' ${testRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);
    const thisFile = path.basename(__filename);
    const offenders = lines.filter(line => !line.includes(thisFile));
    expect(offenders).toEqual([]);
  });

  it('async InboxWriter does not rewrite caller-owned id', () => {
    const inboxWriter = path.join(repoRoot, 'src/foundation/messaging/inbox-writer.ts');
    const cmd = `grep -rEn '${INBOX_REWRITE_FORBIDDEN_RE}' ${inboxWriter} || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });
});
