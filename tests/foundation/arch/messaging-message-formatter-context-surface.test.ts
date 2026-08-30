import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registrySource = readFileSync(
  new URL('../../../src/foundation/messaging/formatter-registry.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging MessageFormatterContext deep surface', () => {
  it('keeps the formatter context interface local behind MessageFormatter', () => {
    expect(registrySource).not.toMatch(/export\s+interface\s+MessageFormatterContext\s*\{/);
    expect(registrySource).toMatch(
      /(?:^|\n)interface\s+MessageFormatterContext\s*\{[\s\S]*?\bfrom:\s*string;[\s\S]*?\bbody:\s*string;[\s\S]*?\btimestampSec:\s*string;[\s\S]*?\}/,
    );
    expect(registrySource).toMatch(
      /export\s+type\s+MessageFormatter\s*=\s*\(ctx:\s*MessageFormatterContext\)\s*=>\s*Promise<string>;/,
    );
    expect(registrySource).toMatch(
      /export\s+function\s+renderStandardInboxMessage\(\s*ctx:\s*MessageFormatterContext,/,
    );
    expect(barrelSource).toMatch(
      /export\s+type\s*\{[^}]*\bMessageFormatter\b[^}]*\}\s*from\s*'\.\/formatter-registry\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bMessageFormatterContext\b/);
  });
});
