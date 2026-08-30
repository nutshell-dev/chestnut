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

describe('Snapshot SnapshotInitFailedPayload deep surface', () => {
  it('keeps the init-failed payload type local behind emitSnapshotInitFailed', () => {
    expect(auditEmitSource).not.toMatch(/export\s+type\s+SnapshotInitFailedPayload\b/);
    expect(auditEmitSource).toMatch(
      /(?:^|\n)type\s+SnapshotInitFailedPayload\s*=\s*\{\s*\bdir:\s*string;\s*\bkind\?:\s*string;\s*\bcontext\?:\s*'incomplete_repo_reinit';\s*\};/,
    );
    expect(auditEmitSource).toMatch(
      /export\s+function\s+emitSnapshotInitFailed\(audit:\s*AuditLog,\s*opts:\s*SnapshotInitFailedPayload\):\s*void\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bSnapshotInitFailedPayload\b/);
  });
});
