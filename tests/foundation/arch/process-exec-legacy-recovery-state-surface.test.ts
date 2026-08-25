import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const legacySource = readFileSync(
  new URL('../../../src/foundation/process-exec/legacy-process.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-exec/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessExec LegacyProcessRecoveryState deep surface', () => {
  it('keeps the legacy recovery union local behind probeLegacyProcess', () => {
    expect(legacySource).not.toMatch(/export\s+type\s+LegacyProcessRecoveryState\s*=/);
    expect(legacySource).toMatch(/(?:^|\n)type\s+LegacyProcessRecoveryState\s*=/);
    expect(legacySource).toMatch(/\|\s*\{\s*kind:\s*'alive'\s*\}/);
    expect(legacySource).toMatch(/\|\s*\{\s*kind:\s*'gone'\s*\}/);
    expect(legacySource).toMatch(
      /\|\s*\{\s*kind:\s*'indeterminate';\s*reason:\s*string\s*\};/,
    );
    expect(legacySource).toMatch(
      /export\s+function\s+probeLegacyProcess\([\s\S]*?\):\s*LegacyProcessRecoveryState\s*\{/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{\s*probeLegacyProcess,\s*terminateLegacyProcess\s*\}\s*from\s*'\.\/legacy-process\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bLegacyProcessRecoveryState\b/);
  });
});
