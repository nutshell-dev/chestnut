import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('ContextManager no business-field direct read (phase 1861, CM-D4 + CM-D10)', () => {
  const trimV2 = read('src/core/context_manager/trim-v2.ts');

  it('trim-v2 does not read Message.origin directly (owner-provided classify view instead)', () => {
    expect(trimV2).not.toMatch(/\.origin\b/);
  });

  it('trim-v2 does not read Message.systemSubtype directly (owner-provided classify view instead)', () => {
    expect(trimV2).not.toMatch(/\.systemSubtype\b/);
  });

  it('trim-v2 consumes the owner classification view', () => {
    expect(trimV2).toContain('classifyMessage');
    expect(trimV2).toMatch(/from '\.\.\/\.\.\/foundation\/dialog-store\/index\.js'/);
  });

  it('DialogStore owns the classification view export', () => {
    const barrel = read('src/foundation/dialog-store/index.ts');
    expect(barrel).toContain('classifyMessage');
    expect(barrel).toContain('MessageClassifyView');
  });
});
