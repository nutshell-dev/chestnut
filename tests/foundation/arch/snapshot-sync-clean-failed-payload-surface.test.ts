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

describe('Snapshot SnapshotSyncCleanFailedPayload deep surface', () => {
  it('keeps the sync-clean-failed payload type local behind emitSnapshotSyncCleanFailed', () => {
    expect(auditEmitSource).not.toMatch(/export\s+type\s+SnapshotSyncCleanFailedPayload\b/);
    expect(auditEmitSource).toMatch(
      /(?:^|\n)type\s+SnapshotSyncCleanFailedPayload\s*=\s*\{\s*\bdir:\s*string;\s*\bcontext\?:\s*'empty_or_escaping_relDir'\s*\|\s*'realpath_failed'\s*\|\s*'symlink_traversal';\s*\bcleanupDir\?:\s*string;\s*\bresolved\?:\s*string;\s*\breason\?:\s*string;\s*\};/,
    );
    expect(auditEmitSource).toMatch(
      /export\s+function\s+emitSnapshotSyncCleanFailed\(audit:\s*AuditLog,\s*opts:\s*SnapshotSyncCleanFailedPayload\):\s*void\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bSnapshotSyncCleanFailedPayload\b/);
  });
});
