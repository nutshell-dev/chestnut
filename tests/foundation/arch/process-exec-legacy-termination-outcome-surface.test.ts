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

describe('ProcessExec LegacyProcessTerminationOutcome deep surface', () => {
  it('keeps the legacy termination union local behind terminateLegacyProcess', () => {
    expect(legacySource).not.toMatch(/export\s+type\s+LegacyProcessTerminationOutcome\s*=/);
    expect(legacySource).toMatch(/(?:^|\n)type\s+LegacyProcessTerminationOutcome\s*=/);
    expect(legacySource).toMatch(
      /\|\s*\{\s*status:\s*'gone';\s*pid:\s*number;\s*termSent:\s*boolean;\s*killSent:\s*boolean;\s*completedAt:\s*string\s*\}/,
    );
    expect(legacySource).toMatch(
      /\|\s*\{\s*status:\s*'still_alive';\s*pid:\s*number;\s*termSent:\s*boolean;\s*killSent:\s*boolean;\s*checkedAt:\s*string\s*\}/,
    );
    expect(legacySource).toMatch(
      /\|\s*\{\s*status:\s*'indeterminate';\s*pid:\s*number;\s*termSent:\s*boolean;\s*killSent:\s*boolean;\s*checkedAt:\s*string;\s*reason:\s*string\s*\};/,
    );
    expect(legacySource).toMatch(
      /function\s+goneOutcome\([^)]*\):\s*LegacyProcessTerminationOutcome\s*\{/,
    );
    expect(legacySource).toMatch(
      /function\s+indeterminateOutcome\([\s\S]*?\):\s*LegacyProcessTerminationOutcome\s*\{/,
    );
    expect(legacySource).toMatch(
      /export\s+async\s+function\s+terminateLegacyProcess\([\s\S]*?\):\s*Promise<LegacyProcessTerminationOutcome>\s*\{/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{\s*probeLegacyProcess,\s*terminateLegacyProcess\s*\}\s*from\s*'\.\/legacy-process\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bLegacyProcessTerminationOutcome\b/);
  });
});
