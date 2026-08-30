import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const truncateSource = readFileSync(
  new URL('../../../src/foundation/file-tool/truncate-head-tail.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool TRUNCATE_TAIL_LIMIT deep surface', () => {
  it('keeps the tail limit const local behind truncateHeadTail', () => {
    expect(truncateSource).not.toMatch(/export\s+const\s+TRUNCATE_TAIL_LIMIT\b/);
    expect(truncateSource).toMatch(/(?:^|\n)const\s+TRUNCATE_TAIL_LIMIT\s*=\s*1400;/);
    // total expression still derives from head + tail (Step J retires the derived const)
    expect(truncateSource).toMatch(
      /TRUNCATE_TOTAL_LIMIT\s*=\s*TRUNCATE_HEAD_LIMIT\s*\+\s*TRUNCATE_TAIL_LIMIT;/,
    );
    // tail slice binding
    expect(truncateSource).toMatch(/const\s+tail\s*=\s*content\.slice\(-TRUNCATE_TAIL_LIMIT\);/);
    // truncatedBytes subtraction binding
    expect(truncateSource).toMatch(
      /const\s+truncatedBytes\s*=\s*content\.length\s*-\s*TRUNCATE_HEAD_LIMIT\s*-\s*TRUNCATE_TAIL_LIMIT;/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\btruncateHeadTail\b[^}]*\}\s*from\s*'\.\/truncate-head-tail\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bTRUNCATE_TAIL_LIMIT\b/);
  });
});
