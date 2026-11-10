import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ConfigStoreError,
  isConfigStoreError,
  patchYamlConfig,
  readYamlDocument,
  writeYamlConfig,
} from '../../../src/foundation/config-store/index.js';
import type { ConfigStoreErrorCode } from '../../../src/foundation/config-store/errors.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../../utils/temp.js';

type WriteResult = ReturnType<FileSystem['writeAtomicSync']>;
type WriteMode = 'write' | 'patch';

const modes = ['write', 'patch'] as const;
const outcomes: WriteResult[] = [
  { kind: 'durable' },
  {
    kind: 'committed_platform_limited',
    error: Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }),
  },
  {
    kind: 'committed_durability_unknown',
    error: Object.assign(new Error('directory sync failed'), { code: 'EIO' }),
  },
];
const originalContent = 'token: before\nunknown: keep\n';
const expectedContent = 'token: ${UNRESOLVED_KEY}\nunknown: keep\n';
const expectedDocument = { token: '${UNRESOLVED_KEY}', unknown: 'keep' };

let tempDir: string;
let configPath: string;
let nodeFs: NodeFileSystem;
let deps: { fsFactory: () => NodeFileSystem };

beforeEach(() => {
  tempDir = createTrackedTempDirSync('chestnut-store-write-result-');
  configPath = path.join(tempDir, 'config.yaml');
  nodeFs = new NodeFileSystem({ baseDir: tempDir });
  deps = { fsFactory: () => nodeFs };
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirSync(tempDir);
});

function runWrite(mode: WriteMode): WriteResult {
  if (mode === 'write') {
    return writeYamlConfig(deps, configPath, expectedDocument);
  }
  fs.writeFileSync(configPath, originalContent);
  return patchYamlConfig(deps, configPath, cfg => {
    cfg.token = '${UNRESOLVED_KEY}';
  });
}

function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

function expectStoreError(error: unknown, code: ConfigStoreErrorCode): void {
  expect(isConfigStoreError(error)).toBe(true);
  expect(error).toBeInstanceOf(ConfigStoreError);
  expect((error as ConfigStoreError).code).toBe(code);
}

for (const mode of modes) {
  describe(`config-store ${mode}YamlConfig write results`, () => {
    it.each(outcomes)('returns the identical $kind result after real bytes are committed', outcome => {
      const realWrite = nodeFs.writeAtomicSync.bind(nodeFs);
      const write = vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((file, content) => {
        realWrite(file, content);
        return outcome;
      });

      const actual = runWrite(mode);

      expect(actual).toBe(outcome);
      if (actual.kind !== 'durable' && outcome.kind !== 'durable') {
        expect(actual.error).toBe(outcome.error);
      }
      expect(write).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(expectedContent);
      expect(readYamlDocument(deps, configPath)).toEqual(expectedDocument);
    });

    it('preserves a pre-commit write error, original bytes, and zero retries', () => {
      fs.writeFileSync(configPath, originalContent);
      const writeError = new Error(`injected ${mode} write failure`);
      const write = vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation(() => {
        throw writeError;
      });

      const actual = catchThrown(() => runWrite(mode));

      expect(actual).toBe(writeError);
      expect(write).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContent);
    });

    it('performs real NodeFileSystem I/O without an injected result', () => {
      runWrite(mode);

      expect(fs.readFileSync(configPath, 'utf8')).toBe(expectedContent);
      expect(readYamlDocument(deps, configPath)).toEqual(expectedDocument);
    });
  });
}

describe('config-store write failure behavior', () => {
  it('propagates the identical patcher error without writing or changing bytes', () => {
    fs.writeFileSync(configPath, originalContent);
    const patcherError = new Error('patcher failed');
    const write = vi.spyOn(nodeFs, 'writeAtomicSync');

    const actual = catchThrown(() => patchYamlConfig(deps, configPath, () => {
      throw patcherError;
    }));

    expect(actual).toBe(patcherError);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContent);
  });

  it.each([
    ['invalid_yaml', '{ bad: [ }'],
    ['expected_object', '- one\n- two\n'],
    ['read_failed', null],
  ] as const)('preserves patch %s classification without writing', (code, content) => {
    if (content !== null) fs.writeFileSync(configPath, content);
    const write = vi.spyOn(nodeFs, 'writeAtomicSync');

    const actual = catchThrown(() => patchYamlConfig(deps, configPath, () => {
      throw new Error('patcher must not run');
    }));

    expectStoreError(actual, code);
    expect(write).not.toHaveBeenCalled();
    if (content !== null) expect(fs.readFileSync(configPath, 'utf8')).toBe(content);
  });

  it.each(modes)('preserves %s serialization errors without writing', mode => {
    fs.writeFileSync(configPath, originalContent);
    const serializationError = new Error(`injected ${mode} serialization failure`);
    const write = vi.spyOn(nodeFs, 'writeAtomicSync');
    const throwingGetter = () => { throw serializationError; };

    const actual = catchThrown(() => {
      if (mode === 'write') {
        const document = { token: 'before' };
        Object.defineProperty(document, 'token', { enumerable: true, get: throwingGetter });
        writeYamlConfig(deps, configPath, document);
      } else {
        patchYamlConfig(deps, configPath, cfg => {
          Object.defineProperty(cfg, 'token', { enumerable: true, get: throwingGetter });
        });
      }
    });

    expect(actual).toBe(serializationError);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContent);
  });
});
