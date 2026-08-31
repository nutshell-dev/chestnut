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

describe('Contract CollectedContractEventsResult deep surface', () => {
  it('keeps the collected events result type local behind the collector entry', () => {
    expect(collectorSource).not.toMatch(/export\s+interface\s+CollectedContractEventsResult\b/);
    expect(collectorSource).toMatch(
      /(?:^|\n)interface\s+CollectedContractEventsResult\s*\{[\s\S]*?events:\s*string\[\];[\s\S]*?problemPairs:\s*string\[\];[\s\S]*?\}/,
    );
    expect(collectorSource).toMatch(
      /export\s+async\s+function\s+collectContractEvents\([\s\S]*?\):\s*Promise<CollectedContractEventsResult>\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bCollectedContractEventsResult\b/);
  });
});
