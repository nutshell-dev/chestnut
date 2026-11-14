import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { delimiter, dirname } from 'node:path';

import { exec } from '../../../src/foundation/process-exec/index.js';

describe('ProcessExec host environment', () => {
  it('uses the host path delimiter, drops unauthorized secrets and applies caller overrides', async () => {
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const authorizedPath = process.platform === 'win32' ? 'C:\\authorized\\bin' : '/authorized/bin';
    const secretKey = 'PHASE2146_UNAUTHORIZED_SECRET';
    const previousSecret = process.env[secretKey];
    const previousRoot = process.env.CHESTNUT_ROOT;
    process.env[secretKey] = 'do-not-inherit';
    process.env.CHESTNUT_ROOT = '/host-root';
    try {
      const result = await exec(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        {
          // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
          cwd: os.tmpdir(),
          env: {
            AUTHORIZED: 'yes',
            CHESTNUT_ROOT: '/caller-root',
            [pathKey]: authorizedPath,
          },
        },
      );
      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      const pathKeys = Object.keys(childEnv).filter(key => key.toLowerCase() === 'path');

      expect(pathKeys).toHaveLength(1);
      expect(childEnv[pathKeys[0]!]).toBe(`${dirname(process.execPath)}${delimiter}${authorizedPath}`);
      expect(childEnv.AUTHORIZED).toBe('yes');
      expect(childEnv.CHESTNUT_ROOT).toBe('/caller-root');
      expect(childEnv[secretKey]).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env[secretKey];
      else process.env[secretKey] = previousSecret;
      if (previousRoot === undefined) delete process.env.CHESTNUT_ROOT;
      else process.env.CHESTNUT_ROOT = previousRoot;
    }
  });
});
