import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSchemaSource = readFileSync(
  new URL('../../../src/foundation/tools/config-schema.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/tools/index.ts', import.meta.url),
  'utf8',
);

describe('Tools TOOL_TIMEOUT_DEFAULT_MS deep surface', () => {
  it('keeps the timeout default const local behind toolsConfigSchema', () => {
    expect(configSchemaSource).not.toMatch(/export\s+const\s+TOOL_TIMEOUT_DEFAULT_MS\b/);
    expect(configSchemaSource).toMatch(
      /(?:^|\n)const\s+TOOL_TIMEOUT_DEFAULT_MS\s*=\s*60_000;/,
    );
    expect(configSchemaSource).toMatch(
      /export\s+const\s+toolsConfigSchema\s*=\s*z\s*\.number\(\)\s*\.min\(1000\)\s*\.max\(600000\)\s*\.default\(TOOL_TIMEOUT_DEFAULT_MS\);/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\btoolsConfigSchema\b[^}]*\}\s*from\s*'\.\/config-schema\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bTOOL_TIMEOUT_DEFAULT_MS\b/);
  });
});
