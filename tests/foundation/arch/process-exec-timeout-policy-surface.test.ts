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

describe('ProcessExec ExecTimeoutPolicy deep surface', () => {
  it('keeps the mutually exclusive timeout policy local behind ExecOptions', () => {
    expect(typesSource).not.toMatch(/export\s+type\s+ExecTimeoutPolicy\s*=/);
    expect(typesSource).toMatch(/(?:^|\n)type\s+ExecTimeoutPolicy\s*=/);
    expect(typesSource).toMatch(/timeout\?:\s*number;[\s\S]*?deadlineAtMs\?:\s*never;/);
    expect(typesSource).toMatch(/timeout\?:\s*never;[\s\S]*?deadlineAtMs:\s*number;/);
    expect(typesSource).toMatch(
      /export\s+type\s+ExecOptions\s*=\s*ExecBaseOptions\s*&\s*ExecTimeoutPolicy;/,
    );
    expect(execSource).toMatch(/import\s+type\s*\{[\s\S]*?ExecOptions,[\s\S]*?\}\s+from\s+'\.\/types\.js';/);
    expect(execSource).not.toMatch(/\bExecTimeoutPolicy\b/);
  });
});
