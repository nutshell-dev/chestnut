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

describe('Contract ArchivedContractScanResult deep surface', () => {
  it('keeps the scan result type local behind scanArchivedContracts', () => {
    expect(collectorSource).not.toMatch(/export\s+interface\s+ArchivedContractScanResult\b/);
    expect(collectorSource).toMatch(
      /(?:^|\n)interface\s+ArchivedContractScanResult\s*\{\s*\n\s*entries:\s*ArchivedContractEntry\[\];\s*\n\s*\/\*\*[^*]*\*\/\s*\n\s*incomplete:\s*boolean;\s*\n\}/,
    );
    expect(collectorSource).toMatch(/\):\s*Promise<ArchivedContractScanResult>\s*\{/);
    expect(collectorSource).toMatch(/export\s+async\s+function\s+scanArchivedContracts\(/);
    expect(barrelSource).not.toMatch(/\bArchivedContractScanResult\b/);
  });
});
