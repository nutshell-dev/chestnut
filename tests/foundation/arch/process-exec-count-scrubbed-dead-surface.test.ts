import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const envScrubSource = readFileSync(
  new URL('../../../src/foundation/process-exec/env-scrub.ts', import.meta.url),
  'utf8',
);

describe('ProcessExec countScrubbed dead surface', () => {
  it('does not retain the zero-caller count helper', () => {
    expect(envScrubSource).not.toMatch(/\bcountScrubbed\b/);
  });
});
