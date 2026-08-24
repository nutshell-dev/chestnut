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

describe('ProcessExec readPidArgv deep surface', () => {
  it('keeps raw argv reading local behind the public boolean capability', () => {
    expect(argvVerifySource).not.toMatch(/export\s+function\s+readPidArgv\b/);
    expect(argvVerifySource).toMatch(/(?:^|\n)function\s+readPidArgv\(pid:\s*number\):\s*string\s*\{/);
    expect(argvVerifySource).toMatch(
      /export\s+function\s+isPidArgvMatching\(pid:\s*number,\s*expectedToken:\s*string\):\s*boolean\s*\{[\s\S]*?const\s+argv\s*=\s*readPidArgv\(pid\);/,
    );
    expect(barrelSource).toMatch(/export\s*\{\s*isPidArgvMatching\s*\}\s*from\s*'\.\/argv-verify\.js';/);
    expect(barrelSource).not.toMatch(/\breadPidArgv\b/);
  });
});
