import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const typesSource = readFileSync(
  new URL('../../../src/foundation/process-exec/types.ts', import.meta.url),
  'utf8',
);
const execSource = readFileSync(
  new URL('../../../src/foundation/process-exec/exec.ts', import.meta.url),
  'utf8',
);

describe('ProcessExec ExecBaseOptions deep surface', () => {
  it('keeps the base shape local behind ExecOptions', () => {
    expect(typesSource).not.toMatch(/export\s+interface\s+ExecBaseOptions\b/);
    expect(typesSource).toMatch(/(?:^|\n)interface\s+ExecBaseOptions\s*\{/);
    expect(typesSource).toMatch(
      /export\s+type\s+ExecOptions\s*=\s*ExecBaseOptions\s*&\s*ExecTimeoutPolicy;/,
    );
    expect(execSource).toMatch(/import\s+type\s*\{[\s\S]*?ExecOptions,[\s\S]*?\}\s+from\s+'\.\/types\.js';/);
    expect(execSource).not.toMatch(/\bExecBaseOptions\b/);
  });
});
