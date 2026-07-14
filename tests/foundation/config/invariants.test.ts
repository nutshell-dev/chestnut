import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { getClawDir } from '../../../src/core/claw-topology/claw-instance-paths.js';
import { viewportConfigSchema } from '../../../src/cli/commands/chat-viewport/config-schema.js';
import { EXEC_MAX_OUTPUT } from '../../../src/foundation/command-tool/constants.js';

/**
 * Path getters tests
 */
describe('Phase 537 — getClawDir traversal guard', () => {
  it.each([
    ['..'],
    ['../foo'],
    ['foo/bar'],
    ['.'],
    ['.hidden'],
    [''],
  ])('rejects traversal-style claw id %s', (id) => {
    expect(() => getClawDir(id)).toThrow(/Invalid claw id/);
  });

  it('accepts safe identifiers', () => {
    expect(() => getClawDir('claw1')).not.toThrow();
    expect(() => getClawDir('foo-bar_baz')).not.toThrow();
    expect(() => getClawDir('AlphaNumeric123')).not.toThrow();
  });

  it('rejects backslash in claw id (Windows path separator)', () => {
    expect(() => getClawDir('foo\\bar')).toThrow(/Invalid claw id/);
  });

  it('rejects NUL byte in claw id', () => {
    expect(() => getClawDir('foo\x00bar')).toThrow(/Invalid claw id/);
  });

  it('rejects tab in claw id (control char poisoning audit log readability)', () => {
    expect(() => getClawDir('foo\x09bar')).toThrow(/Invalid claw id/);
  });
});

describe('assembly/config-load: no race tmp naming', () => {
  it('concurrent saveGlobalConfig does not produce .tmp.<ms> orphan files', async () => {
    const tmpDir = await createTrackedTempDir('crud-race-test-');
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
    await cleanupTempDir(tmpDir);
  });

  it('NodeFileSystem.writeAtomicSync uses randomUUID tmp naming', async () => {
    const tmpDir = await createTrackedTempDir('crud-naming-test-');
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    nodeFs.writeAtomicSync('test.txt', 'hello');

    const files = fs.readdirSync(tmpDir);
    // Should only have the final file
    expect(files).toContain('test.txt');
    expect(files).toHaveLength(1);

    await cleanupTempDir(tmpDir);
  });
});

describe('viewportConfigSchema user_input_inline_max_chars (phase 142)', () => {
  it('default value aligns with EXEC_MAX_OUTPUT', () => {
    const config = viewportConfigSchema.parse({});
    expect(config.user_input_inline_max_chars).toBe(EXEC_MAX_OUTPUT);
    expect(config.user_input_inline_max_chars).toBe(2000);
  });

  it('accepts positive integer override', () => {
    expect(viewportConfigSchema.parse({ user_input_inline_max_chars: 1 }).user_input_inline_max_chars).toBe(1);
    expect(viewportConfigSchema.parse({ user_input_inline_max_chars: 100000 }).user_input_inline_max_chars).toBe(100000);
  });

  it('rejects non-positive or non-integer', () => {
    expect(() => viewportConfigSchema.parse({ user_input_inline_max_chars: 0 })).toThrow();
    expect(() => viewportConfigSchema.parse({ user_input_inline_max_chars: -1 })).toThrow();
    expect(() => viewportConfigSchema.parse({ user_input_inline_max_chars: 1.5 })).toThrow();
  });
});

describe('assembly/config-load: uses FileSystem for atomic writes', () => {
  // negative `fs.writeFileSync` callsite implied 0 by depcruise `fs-only-via-foundation-filesystem`
  // (blocks `import from 'fs' | 'node:fs'` → callsite impossible) (phase 363)

  it('contains no Date.now() tmp naming', () => {
    const src = readFileSync('src/assembly/config/config-load.ts', 'utf-8');
    expect(src).not.toMatch(/\$\{Date\.now\(\)\}/);
  });

  it('uses writeAtomicSync for config writes', () => {
    const configLoadSrc = readFileSync('src/assembly/config/config-load.ts', 'utf-8');
    const loaderSrc = readFileSync('src/assembly/config/config-loader.ts', 'utf-8');
    // Phase 10/298/717: write logic remains in config-loader.ts; config-load.ts delegates via writeYamlConfig
    expect(configLoadSrc + loaderSrc).toMatch(/writeAtomicSync\(/);
  });
});
