import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pathsSource = readFileSync(
  new URL('../../../src/foundation/process-manager/paths.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-manager/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessManager getStatusDir dead surface', () => {
  it('keeps getStatusDir retired while STATUS_SUBDIR stays public', () => {
    expect(pathsSource).not.toMatch(/\bgetStatusDir\b/);
    expect(pathsSource).toMatch(/(?:^|\n)export\s+const\s+STATUS_SUBDIR\s*=\s*'status';/);
    expect(pathsSource).not.toMatch(/import\s+\*\s+as\s+path\s+from\s*'path';/);
    expect(pathsSource).not.toMatch(/DaemonDir|ProcessManagerContext/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bSTATUS_SUBDIR\b[^}]*\}\s*from\s*'\.\/paths\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bgetStatusDir\b/);
  });
});
