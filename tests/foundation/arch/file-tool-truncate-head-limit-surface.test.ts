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

describe('FileTool TRUNCATE_HEAD_LIMIT deep surface', () => {
  it('keeps the head limit const local behind truncateHeadTail', () => {
    expect(truncateSource).not.toMatch(/export\s+const\s+TRUNCATE_HEAD_LIMIT\b/);
    expect(truncateSource).toMatch(/(?:^|\n)const\s+TRUNCATE_HEAD_LIMIT\s*=\s*600;/);
    // derived total const retired in Step J: name must stay absent
    expect(truncateSource).not.toMatch(/\bTRUNCATE_TOTAL_LIMIT\b/);
    // head slice binding
    expect(truncateSource).toMatch(/const\s+head\s*=\s*content\.slice\(0,\s*TRUNCATE_HEAD_LIMIT\);/);
    // truncatedBytes subtraction binding
    expect(truncateSource).toMatch(
      /const\s+truncatedBytes\s*=\s*content\.length\s*-\s*TRUNCATE_HEAD_LIMIT\s*-\s*TRUNCATE_TAIL_LIMIT;/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\btruncateHeadTail\b[^}]*\}\s*from\s*'\.\/truncate-head-tail\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bTRUNCATE_HEAD_LIMIT\b/);
  });
});
