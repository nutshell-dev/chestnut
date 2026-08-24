import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const idSource = readFileSync(
  new URL('../../../src/foundation/node-utils/id.ts', import.meta.url),
  'utf8',
);

describe('NodeUtils UUID_SHORT_LEN deep surface', () => {
  it('keeps the default length constant local and bound to both public helpers', () => {
    expect(idSource).not.toMatch(/export\s+const\s+UUID_SHORT_LEN\s*=/);
    expect(idSource).toMatch(/(?:^|\n)const\s+UUID_SHORT_LEN\s*=\s*8;/);
    expect(idSource).toMatch(/uuidToShort\(uuid:\s*string,\s*len:\s*number\s*=\s*UUID_SHORT_LEN\)/);
    expect(idSource).toMatch(/newShortUuid\(len:\s*number\s*=\s*UUID_SHORT_LEN\)/);
  });
});
