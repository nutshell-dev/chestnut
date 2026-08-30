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

describe('ProcessManager ProcessPidRecord deep surface', () => {
  it('keeps the PID record local behind generation operations', () => {
    expect(generationSource).not.toMatch(/export\s+interface\s+ProcessPidRecord\s*\{/);
    expect(generationSource).toMatch(/(?:^|\n)interface\s+ProcessPidRecord\s*\{/);
    expect(generationSource).toMatch(
      /interface\s+ProcessPidRecord\s*\{[\s\S]*?schema_version:\s*number;[\s\S]*?generation_id:\s*string;[\s\S]*?pid:\s*number;[\s\S]*?start_time\?:\s*string;[\s\S]*?created_at:\s*string;[\s\S]*?\}/,
    );
    expect(generationSource).toMatch(
      /type\s+ProcessReadyRecord\s*=\s*ProcessPidRecord;/,
    );
    expect(generationSource).toMatch(
      /function\s+isPidRecord\(parsed:\s*unknown\):\s*parsed\s+is\s+ProcessPidRecord\s*\{/,
    );
    expect(generationSource).toMatch(
      /function\s+readPidFile[\s\S]*?\|\s*\{\s*status:\s*'ok';\s*record:\s*ProcessPidRecord\s*\}/,
    );
    expect(generationSource).toMatch(
      /export\s+function\s+inspectSpawningPid[\s\S]*?\|\s*\{\s*status:\s*'ok';\s*record:\s*ProcessPidRecord\s*\}/,
    );
    expect(generationSource).toMatch(
      /export\s+function\s+inspectActivePid[\s\S]*?\|\s*\{\s*status:\s*'ok';\s*record:\s*ProcessPidRecord\s*\}/,
    );
    expect(generationSource).toMatch(
      /const\s+pidRecord:\s*ProcessPidRecord\s*=\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bProcessPidRecord\b/);
  });
});
