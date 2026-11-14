import { describe, expect, it } from 'vitest';
import { delimiter } from 'node:path';
import { createSpawnEnvironment } from '../../../src/foundation/process-exec/index.js';
import { augmentNodePath } from '../../../src/foundation/process-exec/spawn-environment.js';

describe('spawn environment construction', () => {
  it('joins the Node bin directory with the host path delimiter without leaking host entries', () => {
    const authorized = { PATH: '/authorized/bin', AUTHORIZED: 'yes' };
    const env = augmentNodePath(
      authorized,
      '/node/bin',
      { PATH: '/host/bin', ARBITRARY_SECRET: 'do-not-inherit' },
      'linux',
    );

    expect(env).toEqual({
      PATH: `/node/bin${delimiter}/authorized/bin`,
      AUTHORIZED: 'yes',
    });
    expect(authorized.PATH).toBe('/authorized/bin');
  });

  it.each(['Path', 'PATH'])('augments an authorized Windows %s entry under its existing key', (pathKey) => {
    const env = augmentNodePath(
      { [pathKey]: 'C:\\authorized\\bin', AUTHORIZED: 'yes' },
      'C:\\node\\bin',
      { Path: 'C:\\host\\bin' },
      'win32',
    );

    expect(env[pathKey]).toBe(`C:\\node\\bin${delimiter}C:\\authorized\\bin`);
    expect(env.AUTHORIZED).toBe('yes');
    expect(Object.keys(env)).toHaveLength(2);
  });

  it('recognizes a host Windows Path fallback without inheriting unrelated host values', () => {
    const env = augmentNodePath(
      { AUTHORIZED: 'yes' },
      'C:\\node\\bin',
      { Path: 'C:\\host\\bin', ARBITRARY_SECRET: 'do-not-inherit' },
      'win32',
    );

    expect(env).toEqual({
      AUTHORIZED: 'yes',
      Path: `C:\\node\\bin${delimiter}C:\\host\\bin`,
    });
  });

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
