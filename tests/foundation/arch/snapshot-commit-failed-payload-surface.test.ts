import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditEmitSource = readFileSync(
  new URL('../../../src/foundation/snapshot/audit-emit.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/snapshot/index.ts', import.meta.url),
  'utf8',
);

describe('Snapshot SnapshotCommitFailedPayload deep surface', () => {
  it('keeps the commit-failed payload type local behind emitSnapshotCommitFailed', () => {
    expect(auditEmitSource).not.toMatch(/export\s+type\s+SnapshotCommitFailedPayload\b/);
    expect(auditEmitSource).toMatch(
      /(?:^|\n)type\s+SnapshotCommitFailedPayload\s*=\s*\{\s*\bdir:\s*string;\s*\bkind\?:\s*string;\s*\bconsecutive\?:\s*number;\s*\bcontext\?:\s*'state_restored_from_disk'\s*\|\s*'persist_failed';\s*\};/,
    );
    expect(auditEmitSource).toMatch(
      /export\s+function\s+emitSnapshotCommitFailed\(audit:\s*AuditLog,\s*opts:\s*SnapshotCommitFailedPayload\):\s*void\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bSnapshotCommitFailedPayload\b/);
  });
});
