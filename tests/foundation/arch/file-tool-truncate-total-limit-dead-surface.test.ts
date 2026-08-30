import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const truncateSource = readFileSync(
  new URL('../../../src/foundation/file-tool/truncate-head-tail.ts', import.meta.url),
  'utf8',
);
const execSource = readFileSync(
  new URL('../../../src/foundation/command-tool/exec.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool TRUNCATE_TOTAL_LIMIT dead surface', () => {
  it('has no TRUNCATE_TOTAL_LIMIT anywhere in product source', () => {
    expect(truncateSource).not.toMatch(/\bTRUNCATE_TOTAL_LIMIT\b/);
    expect(execSource).not.toMatch(/\bTRUNCATE_TOTAL_LIMIT\b/);
    expect(barrelSource).not.toMatch(/\bTRUNCATE_TOTAL_LIMIT\b/);
  });

  it('keeps the local head/tail limits and the 2000B protocol fact intact', () => {
    expect(truncateSource).toMatch(/(?:^|\n)const\s+TRUNCATE_HEAD_LIMIT\s*=\s*600;/);
    expect(truncateSource).toMatch(/(?:^|\n)const\s+TRUNCATE_TAIL_LIMIT\s*=\s*1400;/);
    // protocol comment still states HEAD + TAIL = 2000B without naming the dead symbol
    expect(execSource).toMatch(/EXEC_MAX_OUTPUT\s*===\s*HEAD\s*\+\s*TAIL\s*=\s*2000B/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\btruncateHeadTail\b[^}]*\}\s*from\s*'\.\/truncate-head-tail\.js';/,
    );
    expect(truncateSource).toMatch(
      /export\s+function\s+truncateHeadTail\(content:\s*string,\s*relPath\?:\s*string\):\s*string\s*\{/,
    );
  });
});
