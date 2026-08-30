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

describe('DialogStore PerformRegimeSwitchOpts deep surface', () => {
  it('keeps the opts interface local behind performRegimeSwitch', () => {
    expect(regimeSwitchSource).not.toMatch(/export\s+interface\s+PerformRegimeSwitchOpts\s*\{/);
    expect(regimeSwitchSource).toMatch(
      /(?:^|\n)interface\s+PerformRegimeSwitchOpts\s*\{[\s\S]*?\bstrategy:\s*RegimeStrategy;[\s\S]*?\bnewSystemPrompt:\s*string;[\s\S]*?\bcurrentStore:\s*DialogSessionLifecycle;[\s\S]*?\bdialogStoreFactory:\s*\(\)\s*=>\s*DialogSessionLifecycle;[\s\S]*?\bauditEvents:\s*RegimeSwitchAuditEvents;[\s\S]*?\}/,
    );
    expect(regimeSwitchSource).toMatch(/opts:\s*PerformRegimeSwitchOpts,/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bperformRegimeSwitch\b[^}]*\}\s*from\s*'\.\/regime-switch\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bPerformRegimeSwitchOpts\b/);
  });
});
