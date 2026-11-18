import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';
import { createLLMConfiguration } from '../../src/core/llm-configuration/index.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const configDeps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
  llmConfiguration: createLLMConfiguration({ fsFactory }),
};

const { rlAnswers, connMock } = vi.hoisted(() => ({
  rlAnswers: { queue: [] as string[] },
  connMock: {
    checkLLMConnection: vi.fn(),
    checkLLMConnectionFor: vi.fn(),
    promptReconfigure: vi.fn(),
  },
}));

const mockRl = {
  question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
    cb(rlAnswers.queue.shift() ?? '');
  }),
  close: vi.fn(),
  _writeToOutput: undefined as unknown,
};

vi.mock('readline', () => ({ createInterface: vi.fn(() => mockRl) }));
vi.mock('../../src/cli/llm-connection-check.js', () => ({
  checkLLMConnection: connMock.checkLLMConnection,
  checkLLMConnectionFor: connMock.checkLLMConnectionFor,
  promptReconfigure: connMock.promptReconfigure,
  formatLLMError: vi.fn().mockReturnValue([]),
  LLM_ERROR_HINTS: {},
}));
vi.mock('../../src/watchdog/ensure.js', () => ({
  ensureWatchdog: vi.fn().mockResolvedValue(undefined),
}));

const { createConfigCommand } = await import('../../src/cli/commands/config.js');

let tempDir: string;
let logLines: string[];
let errorLines: string[];

function configPath(): string {
  return path.join(tempDir, '.chestnut', 'llm', 'config.yaml');
}

function writeConfig(body: string): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `schema_version: 1\nrevision: 7\n${body}`);
}

function writeSharedPresetConfig(): void {
  writeConfig(`primary:
  label: primary-label
  preset: shared
fallbacks:
  - label: one
    preset: shared
    model: model-one
  - preset: shared
    model: model-two
`);
}

function snapshot() {
  return {
    bytes: fs.readFileSync(configPath(), 'utf8'),
    document: configDeps.llmConfiguration.store.read(),
    revision: configDeps.llmConfiguration.readRevision().revision,
  };
}

function expectNoMutationSideEffects(before: ReturnType<typeof snapshot>): void {
  expect(snapshot()).toEqual(before);
  expect(fs.existsSync(path.join(tempDir, '.chestnut', 'llm', 'notifications'))).toBe(false);
  const auditPath = path.join(tempDir, '.chestnut', 'audit.tsv');
  const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  expect(audit).not.toContain('cli_config_saved');
}

async function runCommand(args: string[]): Promise<void> {
  await createConfigCommand(configDeps).parseAsync(['node', 'test', ...args]);
}

async function runFailure(args: string[]): Promise<string> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit);
  try {
    await expect(runCommand(args)).rejects.toThrow('process.exit(1)');
  } finally {
    exitSpy.mockRestore();
  }
  return errorLines.join('\n');
}

beforeEach(() => {
  tempDir = createTrackedTempDirSync('chestnut-provider-ambiguity-');
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  vi.stubEnv('CHESTNUT_HOME', path.join(tempDir, 'cred-home'));
  fs.mkdirSync(path.join(tempDir, '.chestnut'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), '{}\n');
  logLines = [];
  errorLines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '));
  });
  rlAnswers.queue = [];
  connMock.checkLLMConnection.mockReset();
  connMock.checkLLMConnectionFor.mockReset();
  connMock.promptReconfigure.mockReset();
  mockRl.question.mockClear();
  mockRl.close.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanupTempDirSync(tempDir);
});

describe('provider mutation ambiguity safety', () => {
  it.each([
    ['remove', ['provider', 'remove', 'shared']],
    ['set-primary', ['provider', 'set-primary', 'shared']],
    ['move', ['provider', 'move', 'shared', '1']],
    ['login', ['provider', 'login', 'shared']],
    ['logout', ['provider', 'logout', 'shared']],
  ])('%s rejects shared preset without changing bytes, order or revision', async (_name, args) => {
    writeSharedPresetConfig();
    const before = snapshot();

    const errors = await runFailure(args);

    expect(errors).toContain('ambiguous_provider_reference');
    expect(errors).toContain('role=primary index=-1 label="primary-label"');
    expect(errors).toContain('role=fallback index=0 label="one"');
    expect(errors).toContain('role=fallback index=1 label="(no label)"');
    expect(errors).toContain('model="model-one"');
    expect(errors).toContain('model="model-two"');
    expectNoMutationSideEffects(before);
    expect(connMock.checkLLMConnection).not.toHaveBeenCalled();
    expect(mockRl.question).not.toHaveBeenCalled();
  });

  it('re-resolves fresh locked config when a unique fallback becomes ambiguous', async () => {
    writeConfig(`primary:
  label: main
  preset: anthropic
fallbacks:
  - label: only
    preset: openai
`);
    const mutate = configDeps.llmConfiguration.mutateGlobalLocked;
    let afterDrift: ReturnType<typeof snapshot> | undefined;
    vi.spyOn(configDeps.llmConfiguration, 'mutateGlobalLocked').mockImplementation(async mutator => {
      await mutate(fresh => {
        fresh.llm.fallbacks!.push({
          label: 'other', preset: 'openai', temperature: 0.7, timeout_ms: 30_000,
        });
      });
      afterDrift = snapshot();
      return mutate(mutator);
    });

    const errors = await runFailure(['provider', 'remove', 'openai']);

    expect(errors).toContain('ambiguous_provider_reference');
    expect(errors).toContain('label="only"');
    expect(errors).toContain('label="other"');
    if (!afterDrift) throw new Error('drift fixture did not run');
    expect(afterDrift.revision).toBe(8);
    expectNoMutationSideEffects(afterDrift);
  });
});

describe('provider actual-target output', () => {
  it('remove uses an exact fallback label even when primary preset has the same text', async () => {
    writeConfig(`primary:
  label: primary-label
  preset: shared
fallbacks:
  - label: shared
    preset: other
  - label: remaining
    preset: openai
`);

    await runCommand(['provider', 'remove', 'shared']);

    const document = configDeps.llmConfiguration.store.read();
    expect(document.primary).toMatchObject({ label: 'primary-label', preset: 'shared' });
    expect(document.fallbacks).toEqual([
      expect.objectContaining({ label: 'remaining', preset: 'openai' }),
    ]);
    expect(logLines.join('\n')).toContain(
      '✓ Removed provider (label="shared" role=fallback match=label) from fallbacks',
    );
  });

  it('remove reports a unique no-label preset fallback without inventing an identity', async () => {
    writeConfig(`primary:
  label: main
  preset: anthropic
fallbacks:
  - preset: openai
`);

    await runCommand(['provider', 'remove', 'openai']);

    expect(configDeps.llmConfiguration.store.read().fallbacks).toEqual([]);
    expect(logLines.join('\n')).toContain(
      '✓ Removed provider (label="(no label)" role=fallback match=preset) from fallbacks',
    );
  });

  it('set-primary reports the actual no-label target and compatibility match', async () => {
    writeConfig(`primary:
  label: main
  preset: anthropic
fallbacks:
  - preset: openai
`);
    rlAnswers.queue = ['y'];
    connMock.checkLLMConnection.mockResolvedValue({ ok: true, model: 'gpt-test' });

    await runCommand(['provider', 'set-primary', 'openai']);

    expect(configDeps.llmConfiguration.store.read().primary).toMatchObject({ preset: 'openai' });
    expect(logLines.join('\n')).toContain(
      '✓ Provider (label="(no label)" role=fallback match=preset) is now primary',
    );
    expect(connMock.checkLLMConnection).toHaveBeenCalledOnce();
  });

  it('move reports the actual target and preserves the resolved entry', async () => {
    writeConfig(`primary:
  label: main
  preset: anthropic
fallbacks:
  - preset: openai
  - label: second
    preset: other
`);

    await runCommand(['provider', 'move', 'openai', '2']);

    expect(configDeps.llmConfiguration.store.read().fallbacks).toEqual([
      expect.objectContaining({ label: 'second', preset: 'other' }),
      expect.objectContaining({ preset: 'openai' }),
    ]);
    expect(logLines.join('\n')).toContain(
      '✓ Provider (label="(no label)" role=fallback match=preset) moved to fallback #2',
    );
  });

  it('list displays no-label facts for primary and fallback rows', async () => {
    writeConfig(`primary:
  preset: anthropic
fallbacks:
  - preset: openai
  - label: named
    preset: other
`);

    await runCommand(['provider', 'list']);

    const output = logLines.join('\n');
    const primaryRow = logLines.find(line => line.includes('PRIMARY'));
    const firstFallbackRow = logLines.find(line => line.trim().startsWith('#1'));
    expect(primaryRow).toContain('(no label)');
    expect(firstFallbackRow).toContain('(no label)');
    expect(output).toContain('named');
    expect(output).not.toContain('(unknown)');
  });
});
