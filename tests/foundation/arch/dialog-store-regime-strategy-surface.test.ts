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

describe('DialogStore RegimeStrategy deep surface', () => {
  it('keeps the regime strategy type local behind performRegimeSwitch', () => {
    expect(regimeSwitchSource).not.toMatch(/export\s+type\s+RegimeStrategy\b/);
    expect(regimeSwitchSource).toMatch(
      /(?:^|\n)type\s+RegimeStrategy\s*=\s*'all'\s*\|\s*'last-turn'\s*\|\s*'none';/,
    );
    expect(regimeSwitchSource).toMatch(/strategy:\s*RegimeStrategy;/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bperformRegimeSwitch\b[^}]*\}\s*from\s*'\.\/regime-switch\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bRegimeStrategy\b/);
  });
});
