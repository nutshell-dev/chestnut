import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const blockIdIndexSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/block-id-index.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/index.ts', import.meta.url),
  'utf8',
);

describe('DialogStore BlockIdIndexAuditWriter deep surface', () => {
  it('keeps the audit writer type local behind BlockIdIndex', () => {
    expect(blockIdIndexSource).not.toMatch(/export\s+interface\s+BlockIdIndexAuditWriter\s*\{/);
    expect(blockIdIndexSource).toMatch(
      /(?:^|\n)interface\s+BlockIdIndexAuditWriter\s*\{\s*write\(event:\s*string,\s*\.\.\.details:\s*string\[\]\):\s*void;\s*\}/,
    );
    expect(blockIdIndexSource).toMatch(
      /load\(auditWriter\?:\s*BlockIdIndexAuditWriter\):\s*void\s*\{/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bBlockIdIndex\b[^}]*\}\s*from\s*'\.\/block-id-index\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bBlockIdIndexAuditWriter\b/);
  });
});
