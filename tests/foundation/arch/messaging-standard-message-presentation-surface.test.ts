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

describe('Messaging StandardMessagePresentation deep surface', () => {
  it('keeps the standard presentation type local behind renderStandardInboxMessage', () => {
    expect(registrySource).not.toMatch(/export\s+type\s+StandardMessagePresentation\b/);
    expect(registrySource).toMatch(
      /(?:^|\n)type\s+StandardMessagePresentation\s*=\s*'system'\s*\|\s*'user_chat'\s*\|\s*'user_inbox';/,
    );
    expect(registrySource).toMatch(
      /export\s+type\s+InboxMessageRendering\s*=\s*\|\s*\{\s*readonly\s+kind:\s*'standard';\s*readonly\s+presentation:\s*StandardMessagePresentation\s*\}/,
    );
    expect(registrySource).toMatch(
      /export\s+function\s+renderStandardInboxMessage\(\s*ctx:\s*MessageFormatterContext,\s*presentation:\s*StandardMessagePresentation,\s*\):\s*string\s*\{/,
    );
    expect(registrySource).toMatch(
      /case\s*'system':[\s\S]*?case\s*'user_inbox':[\s\S]*?case\s*'user_chat':[\s\S]*?default:\s*return\s+assertNever\(presentation\);/,
    );
    expect(barrelSource).not.toMatch(/\bStandardMessagePresentation\b/);
  });
});
