import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const argvVerifySource = readFileSync(
  new URL('../../../src/foundation/process-exec/argv-verify.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-exec/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessExec argv observation surface', () => {
  it('keeps host argv parsing local with typed observation and a legacy boolean wrapper', () => {
    expect(argvVerifySource).not.toMatch(/export\s+function\s+readPidArgv\b/);
    expect(argvVerifySource).toMatch(/export\s+function\s+observePidArgv\(/);
    expect(argvVerifySource).toMatch(
      /export\s+function\s+isPidArgvMatching\(pid:\s*number,\s*expectedToken:\s*string\):\s*boolean\s*\{[\s\S]*?observePidArgv\(pid,\s*expectedToken\)/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{\s*isPidArgvMatching,\s*observePidArgv\s*\}\s*from\s*'\.\/argv-verify\.js';/,
    );
    expect(barrelSource).not.toMatch(/\breadPidArgv\b/);
  });
});
