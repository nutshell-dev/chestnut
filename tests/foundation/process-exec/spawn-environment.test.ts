import { describe, expect, it } from 'vitest';
import { createSpawnEnvironment } from '../../../src/foundation/process-exec/index.js';

describe('spawn environment construction', () => {
  it('allowlists host facts and applies only explicit caller authorization', () => {
    const result = createSpawnEnvironment(
      { CHESTNUT_ROOT: '/authorized-root', EXPLICIT_EMPTY: '' },
      {
        PATH: '/usr/bin',
        Path: 'C\\Windows\\System32',
        SystemRoot: 'C\\Windows',
        CHESTNUT_LEGACY: 'compatible',
        ARBITRARY_SECRET: 'do-not-inherit',
      },
    );

    expect(result).toEqual({
      kind: 'created',
      env: {
        PATH: '/usr/bin',
        Path: 'C\\Windows\\System32',
        SystemRoot: 'C\\Windows',
        CHESTNUT_LEGACY: 'compatible',
        CHESTNUT_ROOT: '/authorized-root',
        EXPLICIT_EMPTY: '',
      },
    });
  });

  it('supports explicit removal and does not mutate the host environment', () => {
    const host = { PATH: '/usr/bin', CHESTNUT_ROOT: '/old-root' };
    const result = createSpawnEnvironment({ CHESTNUT_ROOT: undefined }, host);

    expect(result).toEqual({ kind: 'created', env: { PATH: '/usr/bin' } });
    expect(host.CHESTNUT_ROOT).toBe('/old-root');
  });

  it('returns the original construction error with encoded evidence', () => {
    const failure = Object.assign(new Error('host env unreadable'), { code: 'EIO' });
    const host = new Proxy({}, {
      ownKeys() { throw failure; },
    }) as NodeJS.ProcessEnv;

    const result = createSpawnEnvironment({}, host);
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed environment');
    expect(result.error).toBe(failure);
    expect(JSON.stringify(result.evidence)).toContain('host env unreadable');
    expect(JSON.stringify(result.evidence)).toContain('EIO');
  });
});
