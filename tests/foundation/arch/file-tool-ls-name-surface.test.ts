import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const lsSource = readFileSync(
  new URL('../../../src/foundation/file-tool/ls.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool LS_TOOL_NAME deep surface', () => {
  it('keeps the ls tool name const local behind lsTool', () => {
    expect(lsSource).not.toMatch(/export\s+const\s+LS_TOOL_NAME\b/);
    expect(lsSource).toMatch(/(?:^|\n)const\s+LS_TOOL_NAME\s*=\s*'ls' as const;/);
    expect(lsSource).toMatch(/\n\s*name:\s*LS_TOOL_NAME,/);
    expect(barrelSource).not.toMatch(/\bLS_TOOL_NAME\b/);
  });
});
