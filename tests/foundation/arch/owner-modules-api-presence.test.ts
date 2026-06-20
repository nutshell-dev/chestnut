import { describe, it, expect } from 'vitest';

/**
 * phase 503: invariant test for foundation/uuid + foundation/hash owner module APIs.
 *
 * Asserts canonical exports exist. Renaming a function or removing
 * one breaks downstream callers and dual lint protection — this catches
 * the regression at test time.
 */
describe('owner modules API presence (phase 503)', () => {
  it('foundation/uuid exposes newUuid, newShortUuid, randomHex', async () => {
    const uuidMod = await import('../../../src/foundation/uuid.js');
    expect(typeof uuidMod.newUuid).toBe('function');
    expect(typeof uuidMod.newShortUuid).toBe('function');
    expect(typeof uuidMod.randomHex).toBe('function');

    const id = uuidMod.newUuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(uuidMod.newShortUuid().length).toBe(8);
    expect(uuidMod.newShortUuid(12).length).toBe(12);
    expect(uuidMod.randomHex(8).length).toBe(16);
  });

  it('foundation/hash exposes sha256Hex, sha256ShortHex, createSha256Hasher', async () => {
    const hashMod = await import('../../../src/foundation/hash.js');
    expect(typeof hashMod.sha256Hex).toBe('function');
    expect(typeof hashMod.sha256ShortHex).toBe('function');
    expect(typeof hashMod.createSha256Hasher).toBe('function');

    expect(hashMod.sha256Hex('test')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
    expect(hashMod.sha256ShortHex('test', 8)).toBe('9f86d081');

    const h = hashMod.createSha256Hasher();
    h.update('test');
    expect(h.digest()).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });
});
