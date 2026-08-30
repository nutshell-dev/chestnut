import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const writerSource = readFileSync(
  new URL('../../../src/foundation/stream/writer.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/stream/index.ts', import.meta.url),
  'utf8',
);

describe('Stream StreamRetentionOptions deep surface', () => {
  it('keeps the retention options interface local behind StreamWriter', () => {
    expect(writerSource).not.toMatch(/export\s+interface\s+StreamRetentionOptions\s*\{/);
    expect(writerSource).toMatch(
      /(?:^|\n)interface\s+StreamRetentionOptions\s*\{\s*\bmaxFiles\?:\s*number\s*\|\s*null;\s*\bmaxDays\?:\s*number\s*\|\s*null;\s*\}/,
    );
    expect(writerSource).toMatch(/private\s+retention:\s*StreamRetentionOptions;/);
    expect(writerSource).toMatch(
      /constructor\(fs:\s*FileSystem,\s*audit:\s*AuditLog,\s*retention:\s*StreamRetentionOptions\s*=\s*\{\}\)/,
    );
    expect(writerSource).toMatch(/(?:^|\n)\s*retention\?:\s*StreamRetentionOptions,/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bStreamWriter\b[^}]*\}\s*from\s*'\.\/writer\.js';/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bcreateStreamWriter\b[^}]*\}\s*from\s*'\.\/writer\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bStreamRetentionOptions\b/);
  });
});
