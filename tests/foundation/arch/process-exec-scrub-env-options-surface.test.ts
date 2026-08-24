import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const envScrubSource = readFileSync(
  new URL('../../../src/foundation/process-exec/env-scrub.ts', import.meta.url),
  'utf8',
);

describe('ProcessExec ScrubEnvOptions deep surface', () => {
  it('keeps the options interface local and bound to scrubEnv', () => {
    expect(envScrubSource).not.toMatch(/export\s+interface\s+ScrubEnvOptions\b/);
    expect(envScrubSource).toMatch(
      /interface\s+ScrubEnvOptions\s*\{[\s\S]*?allowExtra\?:\s*ReadonlyArray<string>;[\s\S]*?\}/,
    );
    expect(envScrubSource).toMatch(
      /export\s+function\s+scrubEnv\([\s\S]*?options:\s*ScrubEnvOptions\s*=\s*\{\}/,
    );
  });
});
