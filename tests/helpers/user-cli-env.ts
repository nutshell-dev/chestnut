import { CALLER_AGENT_ID_ENV } from '../../src/foundation/command-tool/index.js';

export function userCliEnv(root: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited, CHESTNUT_ROOT: root, NODE_ENV: 'test', GIT_CONFIG_NOSYSTEM: '1' };
  delete env[CALLER_AGENT_ID_ENV];
  return env;
}
