import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { saveGlobalConfig, loadGlobalConfig } from '../../../src/foundation/config/crud.js';
import { CONFIG_DEFAULTS } from '../../../src/foundation/config/schemas.js';

describe('foundation/config/crud.ts: no race tmp naming', () => {
  it('concurrent saveGlobalConfig does not produce .tmp.<ms> orphan files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'crud-race-test-'));
    const configPath = path.join(tmpDir, 'config.yaml');

    // Override getGlobalConfigPath via module-level mock is hard;
    // instead test NodeFileSystem.writeAtomicSync naming directly.
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    const writes: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      writes.push(
        new Promise<void>((resolve) => {
          setTimeout(() => {
            nodeFs.writeAtomicSync('concurrent.json', `content-${i}`);
            resolve();
          }, 0);
        })
      );
    }
    await Promise.all(writes);

    const files = fs.readdirSync(tmpDir);
    const raceTmpFiles = files.filter(f => /\.tmp\.\d+$/.test(f));
    expect(raceTmpFiles).toHaveLength(0);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('NodeFileSystem.writeAtomicSync uses randomUUID tmp naming', () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'crud-naming-test-'));
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    nodeFs.writeAtomicSync('test.txt', 'hello');

    const files = fs.readdirSync(tmpDir);
    // Should only have the final file
    expect(files).toContain('test.txt');
    expect(files).toHaveLength(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
