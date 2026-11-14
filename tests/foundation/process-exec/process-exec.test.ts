import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { delimiter, dirname } from 'node:path';

import { exec } from '../../../src/foundation/process-exec/index.js';

describe('ProcessExec host environment', () => {
  it('uses the host path delimiter while preserving explicit env isolation', async () => {
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const authorizedPath = process.platform === 'win32' ? 'C:\\authorized\\bin' : '/authorized/bin';
    const result = await exec(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      {
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        cwd: os.tmpdir(),
        env: { AUTHORIZED: 'yes', [pathKey]: authorizedPath },
      },
    );
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    const pathKeys = Object.keys(childEnv).filter(key => key.toLowerCase() === 'path');

    expect(pathKeys).toHaveLength(1);
    expect(childEnv[pathKeys[0]!]).toBe(`${dirname(process.execPath)}${delimiter}${authorizedPath}`);
    expect(childEnv.AUTHORIZED).toBe('yes');
    expect(childEnv).not.toHaveProperty('HOME');
  });
});
