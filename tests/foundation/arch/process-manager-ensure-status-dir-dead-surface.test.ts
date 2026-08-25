import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pathsSource = readFileSync(
  new URL('../../../src/foundation/process-manager/paths.ts', import.meta.url),
  'utf8',
);

describe('ProcessManager ensureStatusDir dead surface', () => {
  it('does not retain the zero-caller status dir ensure helper', () => {
    expect(pathsSource).not.toMatch(/\bensureStatusDir\b/);
  });
});
