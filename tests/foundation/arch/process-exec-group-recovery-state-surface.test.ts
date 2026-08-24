import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const groupSource = readFileSync(
  new URL('../../../src/foundation/process-exec/execution-group.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-exec/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessExec ExecutionGroupRecoveryState deep surface', () => {
  it('keeps the recovery union local behind probeExecutionGroup', () => {
    expect(groupSource).not.toMatch(/export\s+type\s+ExecutionGroupRecoveryState\s*=/);
    expect(groupSource).toMatch(/(?:^|\n)type\s+ExecutionGroupRecoveryState\s*=/);
    expect(groupSource).toMatch(/\|\s*\{\s*kind:\s*'verified_alive'\s*\}/);
    expect(groupSource).toMatch(/\|\s*\{\s*kind:\s*'gone'\s*\}/);
    expect(groupSource).toMatch(
      /\|\s*\{\s*kind:\s*'indeterminate';\s*reason:\s*string\s*\};/,
    );
    expect(groupSource).toMatch(
      /export\s+function\s+probeExecutionGroup\([\s\S]*?\):\s*ExecutionGroupRecoveryState\s*\{/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{\s*terminateExecutionGroup,\s*probeExecutionGroup\s*\}\s*from\s*'\.\/execution-group\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bExecutionGroupRecoveryState\b/);
  });
});
