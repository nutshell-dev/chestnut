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

describe('ProcessManager stopProcessDetailed deep surface', () => {
  it('keeps the detailed stop variant local behind the public stopProcess', () => {
    expect(stopSource).not.toMatch(/export\s+(async\s+)?function\s+stopProcessDetailed\b/);
    expect(stopSource).toMatch(/async\s+function\s+stopProcessDetailed\(/);
    expect(stopSource).toMatch(/await\s+stopProcessDetailed\(ctx,\s*daemonDir\)/);
    expect(stopSource).toMatch(/export\s+async\s+function\s+stopProcess\(/);
    expect(barrelSource).not.toMatch(/\bstopProcessDetailed\b/);
  });
});
