import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { truncateHeadTail } from '../../../src/foundation/file-tool/truncate-head-tail.js';

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
    // derived total const retired in Step J: name must stay absent
    expect(truncateSource).not.toMatch(/\bTRUNCATE_TOTAL_LIMIT\b/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\btruncateHeadTail\b[^}]*\}\s*from\s*'\.\/truncate-head-tail\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bTRUNCATE_TAIL_LIMIT\b/);
  });

  it('keeps the tail within 1400 UTF-8 bytes without splitting a code point', () => {
    const input = `${'a'.repeat(600)}😀${'z'.repeat(1399)}`;
    const preview = truncateHeadTail(input);

    expect(preview.startsWith(`${'a'.repeat(600)}\n[...truncated 4 bytes...]\n`)).toBe(true);
    expect(preview.endsWith('z'.repeat(1399))).toBe(true);
    expect(preview).not.toContain('\uFFFD');
  });
});
