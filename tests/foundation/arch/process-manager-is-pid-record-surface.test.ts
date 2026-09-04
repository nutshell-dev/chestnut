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

describe('ProcessManager isPidRecord deep surface', () => {
  it('keeps the PID record type guard local behind the public inspection helpers', () => {
    expect(generationSource).not.toMatch(/export\s+function\s+isPidRecord\b/);
    expect(generationSource).toMatch(
      /(?:^|\n)function\s+isPidRecord\(parsed:\s*unknown\):\s*parsed\s+is\s+ProcessPidRecord\s*\{/,
    );
    // phase 1774: 只断言稳定语义（malformed 分支 + shape cause），不绑定排版/附加字段
    //（phase 1771 起 ready 分支携带 source: 'shape' 等 evidence 字段）
    expect(generationSource).toMatch(
      /if\s*\(\s*!isPidRecord\(parsed\)\)\s*return\s*\{\s*status:\s*'malformed',\s*cause:\s*'pid_shape_mismatch'/,
    );
    expect(generationSource).toMatch(
      /if\s*\(\s*!isPidRecord\(parsed\)\)\s*return\s*\{\s*status:\s*'malformed',\s*cause:\s*'ready_shape_mismatch'/,
    );
    expect(barrelSource).not.toMatch(/\bisPidRecord\b/);
  });
});
