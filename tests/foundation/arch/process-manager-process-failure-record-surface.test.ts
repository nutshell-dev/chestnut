import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const generationSource = readFileSync(
  new URL('../../../src/foundation/process-manager/generation.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-manager/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessManager ProcessFailureRecord deep surface', () => {
  it('keeps the failure record local behind generation operations', () => {
    expect(generationSource).not.toMatch(/export\s+interface\s+ProcessFailureRecord\s*\{/);
    expect(generationSource).toMatch(/(?:^|\n)interface\s+ProcessFailureRecord\s*\{/);
    expect(generationSource).toMatch(
      /interface\s+ProcessFailureRecord\s*\{[\s\S]*?schema_version:\s*number;[\s\S]*?generation_id:\s*string;[\s\S]*?reason:\s*string;[\s\S]*?created_at:\s*string;[\s\S]*?\}/,
    );
    expect(generationSource).toMatch(
      /function\s+isFailureRecord\(parsed:\s*unknown\):\s*parsed\s+is\s+ProcessFailureRecord\s*\{/,
    );
    expect(generationSource).toMatch(
      /function\s+readFailureFile[\s\S]*?\|\s*\{\s*status:\s*'ok';\s*record:\s*ProcessFailureRecord\s*\}/,
    );
    expect(generationSource).toMatch(
      /export\s+function\s+inspectSpawningFailure[\s\S]*?\|\s*\{\s*status:\s*'ok';\s*record:\s*ProcessFailureRecord\s*\}/,
    );
    expect(generationSource).toMatch(
      /export\s+function\s+inspectRetiredFailure[\s\S]*?\|\s*\{\s*status:\s*'ok';\s*record:\s*ProcessFailureRecord\s*\}/,
    );
    expect(generationSource).toMatch(
      /const\s+failure:\s*ProcessFailureRecord\s*=\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bProcessFailureRecord\b/);
  });
});
