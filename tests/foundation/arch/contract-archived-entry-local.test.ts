import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const collectorSource = readFileSync(
  new URL('../../../src/core/contract/jobs/event-collector.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract ArchivedContractEntry deep surface', () => {
  it('keeps the archived entry type local behind the scan result composition', () => {
    expect(collectorSource).not.toMatch(/export\s+interface\s+ArchivedContractEntry\b/);
    expect(collectorSource).toMatch(
      /(?:^|\n)interface\s+ArchivedContractEntry\s*\{\s*\n\s*contractId:\s*string;\s*\n\s*body:\s*string;\s*\n\s*hasFailure:\s*boolean;[\s\S]*?archivedAt:\s*number;[\s\S]*?status:\s*ObservedArchiveStatus;/,
    );
    expect(collectorSource).toMatch(/\bentries:\s*ArchivedContractEntry\[\]/);
    expect(collectorSource).toMatch(/export\s+async\s+function\s+scanArchivedContracts\(/);
    expect(barrelSource).not.toMatch(/\bArchivedContractEntry\b/);
  });
});
