import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pathsSource = readFileSync(
  new URL('../../../src/foundation/process-manager/paths.ts', import.meta.url),
  'utf8',
);

describe('ProcessManager getReadyFile dead surface', () => {
  it('does not retain the zero-caller ready file path helper', () => {
    expect(pathsSource).not.toMatch(/\bgetReadyFile\b/);
  });
});
