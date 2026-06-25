import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { PathGuardError } from '../../../src/foundation/fs/types.js';

describe('NodeFileSystem — exists PathGuardError signal (P1.5 phase 611)', () => {
  const fs = new NodeFileSystem({ baseDir: os.tmpdir() });

  it('throws PathGuardError when probing absolute path', async () => {
    // 修前：catch all 返 false / probing /etc/passwd 静默返 false
    // 修后：PathGuardError 抛 / 安全 signal 保留
    await expect(fs.exists('/etc/passwd')).rejects.toThrow(PathGuardError);
  });

  it('returns false for legitimate non-existent relative path', async () => {
    expect(await fs.exists('definitely-not-exists.txt')).toBe(false);
  });

  it('returns true for existing relative path', async () => {
    // setup: write tmp file in baseDir
    const tmpName = `phase611-${Date.now()}.txt`;
    await fs.writeAtomic(tmpName, 'data');
    expect(await fs.exists(tmpName)).toBe(true);
    // cleanup
    await fs.delete(tmpName).catch(() => { /* silent: cleanup */ });
  });
});
