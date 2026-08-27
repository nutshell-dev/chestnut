import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dirsSource = readFileSync(
  new URL('../../../src/foundation/messaging/dirs.ts', import.meta.url),
  'utf8',
);

describe('Messaging INBOX_INFLIGHT_DIR dead surface', () => {
  it('does not retain the zero-caller inflight dir constant', () => {
    expect(dirsSource).not.toMatch(/\bINBOX_INFLIGHT_DIR\b/);
  });
});
