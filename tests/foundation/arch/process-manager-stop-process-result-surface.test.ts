import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stopSource = readFileSync(
  new URL('../../../src/foundation/process-manager/stop.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-manager/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessManager StopProcessResult deep surface', () => {
  it('keeps the stop result type local behind the public stopProcess', () => {
    expect(stopSource).not.toMatch(/export\s+type\s+StopProcessResult\b/);
    expect(stopSource).toMatch(/(?:^|\n)type\s+StopProcessResult\s*=/);
    expect(stopSource).toMatch(/export\s+async\s+function\s+stopProcess\(/);
    expect(stopSource).toMatch(/shouldAbortSpawningForStop/);
    expect(stopSource.match(/\):\s*Promise<StopProcessResult>\s*\{/g)).toHaveLength(3);
    expect(barrelSource).not.toMatch(/\bStopProcessResult\b/);
  });
});
