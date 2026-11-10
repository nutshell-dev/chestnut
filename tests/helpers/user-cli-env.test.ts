import { describe, expect, it } from 'vitest';
import { CALLER_AGENT_ID_ENV } from '../../src/foundation/command-tool/index.js';
import { userCliEnv } from './user-cli-env.js';

describe('userCliEnv', () => {
  it('creates an isolated user CLI environment without mutating the inherited object', () => {
    const inherited: NodeJS.ProcessEnv = {
      [CALLER_AGENT_ID_ENV]: 'parent-agent',
      CHESTNUT_ROOT: '/parent-root',
      PATH: '/sentinel/bin',
      NODE_ENV: 'development',
      GIT_CONFIG_NOSYSTEM: '0',
    };
    const before = { ...inherited };

    const env = userCliEnv('/fixture-root', inherited);

    expect(env).not.toBe(inherited);
    expect(env).not.toHaveProperty(CALLER_AGENT_ID_ENV);
    expect(env).toMatchObject({
      CHESTNUT_ROOT: '/fixture-root',
      PATH: '/sentinel/bin',
      NODE_ENV: 'test',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    expect(inherited).toEqual(before);
  });

  it('keeps an absent caller identity absent', () => {
    const inherited = { PATH: '/sentinel/bin' };

    const env = userCliEnv('/fixture-root', inherited);

    expect(env).not.toHaveProperty(CALLER_AGENT_ID_ENV);
    expect(inherited).toEqual({ PATH: '/sentinel/bin' });
  });
});
