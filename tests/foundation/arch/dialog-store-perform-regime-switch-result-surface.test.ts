import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const regimeSwitchSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/regime-switch.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/index.ts', import.meta.url),
  'utf8',
);

describe('DialogStore PerformRegimeSwitchResult deep surface', () => {
  it('keeps the result interface local behind performRegimeSwitch', () => {
    expect(regimeSwitchSource).not.toMatch(/export\s+interface\s+PerformRegimeSwitchResult\s*\{/);
    expect(regimeSwitchSource).toMatch(
      /(?:^|\n)interface\s+PerformRegimeSwitchResult\s*\{\s*\bnewStore:\s*DialogSessionLifecycle;\s*\binheritedCount:\s*number;\s*\bdiscardedCount:\s*number;\s*\}/,
    );
    expect(regimeSwitchSource).toMatch(/\):\s*Promise<PerformRegimeSwitchResult>\s*\{/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bperformRegimeSwitch\b[^}]*\}\s*from\s*'\.\/regime-switch\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bPerformRegimeSwitchResult\b/);
  });
});
