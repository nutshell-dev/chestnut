import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pathsSource = readFileSync(
  new URL('../../../src/foundation/process-manager/paths.ts', import.meta.url),
  'utf8',
);

describe('ProcessManager getPidFile dead surface', () => {
  it('does not retain the zero-caller pid file path helper', () => {
    expect(pathsSource).not.toMatch(/\bgetPidFile\b/);
  });
});
