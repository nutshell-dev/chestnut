import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';
import { createLLMConfiguration } from '../../src/core/llm-configuration/index.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { CLI_AUDIT_EVENTS } from '../../src/cli/audit-events.js';
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
vi.mock('../../src/cli/llm-probe.js', () => ({
  probeLLMConnection: connMock.checkLLMConnectionFor,
  LLM_ERROR_HINTS: {},
  LLM_ERROR_LABELS: {},
  classifyLLMErrorForDisplay: vi.fn().mockReturnValue('unknown'),
}));
vi.mock('../../src/cli/llm-connection-check.js', () => ({
  checkLLMConnection: connMock.checkLLMConnection,
  checkLLMConnectionFor: connMock.checkLLMConnectionFor,
  probeLLMConnection: connMock.checkLLMConnectionFor,
  promptReconfigure: connMock.promptReconfigure,
  formatLLMError: vi.fn().mockReturnValue([]),
  LLM_ERROR_HINTS: {},
  LLM_ERROR_LABELS: {},
  classifyLLMErrorForDisplay: vi.fn().mockReturnValue('unknown'),
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

function writeSharedProviderConfig(): void {
  writeConfig(`primary:
  label: primary-label
  provider_id: custom:shared
  api_format: openai
  auth_profile: ambient
  model: primary-model
  base_url: https://primary.test
fallbacks:
  - label: one
    provider_id: custom:shared
    api_format: openai
    auth_profile: ambient
    model: model-one
    base_url: https://one.test
  - provider_id: custom:shared
    api_format: openai
    auth_profile: ambient
    model: model-two
    base_url: https://two.test
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
  connMock.checkLLMConnectionFor.mockReset().mockResolvedValue({ ok: true, model: 'probe-model' });
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
    ['remove', ['provider', 'remove', 'custom:shared']],
    ['set-primary', ['provider', 'set-primary', 'custom:shared']],
    ['move', ['provider', 'move', 'custom:shared', '1']],
    ['login', ['provider', 'login', 'custom:shared']],
    ['logout', ['provider', 'logout', 'custom:shared']],
  ])('%s rejects shared provider_id without changing bytes, order or revision', async (_name, args) => {
    writeSharedProviderConfig();
    const before = snapshot();

    const errors = await runFailure(args);

    expect(errors).toContain('ambiguous_provider_reference');
    expect(errors).toContain('role=primary index=-1 label="primary-label"');
    expect(errors).toContain('role=fallback index=0 label="one"');
    expect(errors).toContain('role=fallback index=1 label="(no label)"');
    expect(errors).toContain('model="model-one"');
    expect(errors).toContain('model="model-two"');
    const audit = fs.readFileSync(path.join(tempDir, '.chestnut', 'audit.tsv'), 'utf8');
    expect(audit).toContain('cli_config_provider_reference_rejected');
    expect(audit).toContain('reason=ambiguous_provider_reference');
    expect(audit).toContain('revision=7');
    expect(audit).toContain('match=provider_id');
    expect(audit).toContain('candidate_count=3');
    expect(audit).toContain('reference_sha256=');
    expectNoMutationSideEffects(before);
    expect(connMock.checkLLMConnection).not.toHaveBeenCalled();
    expect(mockRl.question).not.toHaveBeenCalled();
  });

  it('fails closed when fresh locked config revision makes a unique fallback ambiguous', async () => {
    writeConfig(`primary:
  label: main
  provider_id: custom:anthropic
  api_format: anthropic
  auth_profile: ambient
  model: claude-test
  base_url: https://anthropic.test
fallbacks:
  - label: only
    provider_id: custom:openai
    api_format: openai
    auth_profile: ambient
    model: gpt-test
    base_url: https://openai.test
`);
    const mutate = configDeps.llmConfiguration.mutateGlobalLocked;
    let afterDrift: ReturnType<typeof snapshot> | undefined;
    vi.spyOn(configDeps.llmConfiguration, 'mutateGlobalLocked').mockImplementation(async mutator => {
      await mutate(fresh => {
        fresh.llm.fallbacks!.push({
          label: 'other',
          provider_id: 'custom:openai',
          api_format: 'openai',
          auth_profile: 'ambient',
          model: 'gpt-other',
          base_url: 'https://other.test',
          temperature: 0.7,
          timeout_ms: 30_000,
        });
      });
      afterDrift = snapshot();
      return mutate(mutator);
    });

    const errors = await runFailure(['provider', 'remove', 'custom:openai']);

    expect(errors).toContain('provider_target_drift');
    expect(errors).not.toContain('label="other" role=fallback');
    if (!afterDrift) throw new Error('drift fixture did not run');
    expect(afterDrift.revision).toBe(8);
    expectNoMutationSideEffects(afterDrift);
  });

  it('redacts sensitive URL parts from terminal and reconstructable ambiguity audit evidence', async () => {
    writeConfig(`primary:
  label: main
  provider_id: custom:main
  api_format: openai
  auth_profile: ambient
  model: main-model
  base_url: https://main.test
fallbacks:
  - label: one
    provider_id: custom:shared
    api_format: openai
    auth_profile: ambient
    model: model-one
    base_url: 'https://user:secret-one@one.test/v1?token=query-secret&signature=signed#fragment-one'
  - provider_id: custom:shared
    api_format: openai
    auth_profile: ambient
    model: model-two
    base_url: 'https://user:secret-two@two.test/v1?access_token=token-secret#fragment-two'
`);
    const before = snapshot();

    const errors = await runFailure(['provider', 'remove', 'custom:shared']);
    const audit = fs.readFileSync(path.join(tempDir, '.chestnut', 'audit.tsv'), 'utf8');

    for (const evidence of [errors, audit]) {
      expect(evidence).toContain('https://one.test/v1');
      expect(evidence).toContain('https://two.test/v1');
      expect(evidence).not.toContain('secret-one');
      expect(evidence).not.toContain('secret-two');
      expect(evidence).not.toContain('query-secret');
      expect(evidence).not.toContain('signed');
      expect(evidence).not.toContain('token-secret');
      expect(evidence).not.toContain('fragment-one');
      expect(evidence).not.toContain('fragment-two');
    }
    expect(audit).toContain('cli_config_provider_reference_rejected');
    expect(audit).toContain('revision=7');
    expect(audit).toContain('match=provider_id');
    expect(audit).toContain('candidate_count=2');
    expect(audit).toContain('"role":"fallback"');
    expect(audit).toContain('"label_state":"missing"');
    expectNoMutationSideEffects(before);
  });

  it('redacts non-HTTP(S) and invalid URLs from ambiguity terminal and audit evidence', async () => {
    writeConfig(`primary:
  label: main
  provider_id: custom:main
  api_format: openai
  auth_profile: ambient
  model: main-model
  base_url: https://main.test
fallbacks:
  - label: data
    provider_id: custom:shared
    api_format: openai
    auth_profile: ambient
    model: model-data
    base_url: 'data:text/plain,dummy-data-secret'
  - label: mail
    provider_id: custom:shared
    api_format: openai
    auth_profile: ambient
    model: model-mail
    base_url: 'mailto:dummy-mail-secret@example.test'
  - label: invalid
    provider_id: custom:shared
    api_format: openai
    auth_profile: ambient
    model: model-invalid
    base_url: 'not a URL containing dummy-parse-secret'
`);
    const before = snapshot();

    const errors = await runFailure(['provider', 'remove', 'custom:shared']);
    const audit = fs.readFileSync(path.join(tempDir, '.chestnut', 'audit.tsv'), 'utf8');

    for (const evidence of [errors, audit]) {
      expect(evidence).not.toContain('dummy-data-secret');
      expect(evidence).not.toContain('dummy-mail-secret');
      expect(evidence).not.toContain('dummy-parse-secret');
    }
    expect(errors).toContain('base_url="[redacted]"');
    expect(audit).toContain('"base_url":"[redacted]"');
    expect(audit).toContain('cli_config_provider_reference_rejected');
    expect(audit).toContain('candidate_count=3');
    expectNoMutationSideEffects(before);
  });

  it('preserves the original ambiguity CLI failure when its dedicated audit write throws', async () => {
    writeSharedProviderConfig();
    const before = snapshot();
    const originalWrite = AuditWriter.prototype.write;
    vi.spyOn(AuditWriter.prototype, 'write').mockImplementation(function (
      this: AuditWriter,
      type: string,
      ...cols: (string | number)[]
    ) {
      if (type === CLI_AUDIT_EVENTS.CONFIG_PROVIDER_REFERENCE_REJECTED) {
        throw new Error('injected ambiguity audit failure');
      }
      return originalWrite.call(this, type, ...cols);
    });

    const errors = await runFailure(['provider', 'remove', 'custom:shared']);

    expect(errors).toContain('Provider ambiguity audit write failed: injected ambiguity audit failure');
    expect(errors).toContain('ambiguous_provider_reference');
    expect(errors).toContain('provider mutation was not applied');
    expectNoMutationSideEffects(before);
  });

  it.each([
    ['remove', ['provider', 'remove', 'target']],
    ['set-primary', ['provider', 'set-primary', 'target']],
    ['move', ['provider', 'move', 'target', '1']],
  ])('%s fails closed when the preflight target is replaced by a same-label entry', async (_name, args) => {
    writeConfig(`primary:
  label: main
  provider_id: custom:main
  api_format: openai
  auth_profile: ambient
  model: main-model
  base_url: https://main.test
fallbacks:
  - label: target
    provider_id: custom:old
    api_format: openai
    auth_profile: ambient
    model: old-model
    base_url: https://old.test
  - label: remaining
    provider_id: custom:remaining
    api_format: openai
    auth_profile: ambient
    model: remaining-model
    base_url: https://remaining.test
`);
    rlAnswers.queue = ['y'];
    const mutate = configDeps.llmConfiguration.mutateGlobalLocked;
    let afterDrift: ReturnType<typeof snapshot> | undefined;
    vi.spyOn(configDeps.llmConfiguration, 'mutateGlobalLocked').mockImplementation(async mutator => {
      await mutate(fresh => {
        fresh.llm.fallbacks![0] = {
          label: 'target',
          provider_id: 'custom:new',
          api_format: 'openai',
          auth_profile: 'ambient',
          model: 'new-model',
          base_url: 'https://new.test',
          temperature: 0.7,
          timeout_ms: 30_000,
        };
      });
      afterDrift = snapshot();
      return mutate(mutator);
    });

    const errors = await runFailure(args);

    expect(errors).toContain('provider_target_drift');
    if (!afterDrift) throw new Error('drift fixture did not run');
    expect(afterDrift.revision).toBe(8);
    expect(afterDrift.document.fallbacks?.[0]).toMatchObject({
      label: 'target',
      provider_id: 'custom:new',
      model: 'new-model',
    });
    expectNoMutationSideEffects(afterDrift);
    expect(connMock.checkLLMConnection).not.toHaveBeenCalled();
  });
});

describe('provider actual-target output', () => {
  it('remove uses an exact fallback label even when primary provider_id has similar text', async () => {
    writeConfig(`primary:
  label: primary-label
  provider_id: custom:shared
  api_format: openai
  auth_profile: ambient
  model: primary-model
  base_url: https://primary.test
fallbacks:
  - label: shared
    provider_id: custom:other
    api_format: openai
    auth_profile: ambient
    model: other-model
    base_url: https://other.test
  - label: remaining
    provider_id: custom:remaining
    api_format: openai
    auth_profile: ambient
    model: remaining-model
    base_url: https://remaining.test
`);

    await runCommand(['provider', 'remove', 'shared']);

    const document = configDeps.llmConfiguration.store.read();
    expect(document.primary).toMatchObject({ label: 'primary-label', provider_id: 'custom:shared' });
    expect(document.fallbacks).toEqual([
      expect.objectContaining({ label: 'remaining', provider_id: 'custom:remaining' }),
    ]);
    expect(logLines.join('\n')).toContain(
      '✓ Removed provider (label="shared" label_state=present role=fallback match=label) from fallbacks',
    );
  });

  it('remove reports a unique no-label provider_id fallback without inventing an identity', async () => {
    writeConfig(`primary:
  label: main
  provider_id: custom:anthropic
  api_format: anthropic
  auth_profile: ambient
  model: claude-test
  base_url: https://anthropic.test
fallbacks:
  - provider_id: custom:openai
    api_format: openai
    auth_profile: ambient
    model: gpt-test
    base_url: https://openai.test
`);

    await runCommand(['provider', 'remove', 'custom:openai']);

    expect(configDeps.llmConfiguration.store.read().fallbacks).toEqual([]);
    expect(logLines.join('\n')).toContain(
      '✓ Removed provider (label="(no label)" label_state=missing role=fallback match=provider_id) from fallbacks',
    );
  });

  it('set-primary reports the actual no-label target and provider_id match', async () => {
    writeConfig(`primary:
  label: main
  provider_id: custom:anthropic
  api_format: anthropic
  auth_profile: ambient
  model: claude-test
  base_url: https://anthropic.test
fallbacks:
  - provider_id: custom:openai
    api_format: openai
    auth_profile: ambient
    model: gpt-test
    base_url: https://openai.test
`);
    rlAnswers.queue = ['y'];
    connMock.checkLLMConnection.mockResolvedValue({ ok: true, model: 'gpt-test' });

    await runCommand(['provider', 'set-primary', 'custom:openai']);

    expect(configDeps.llmConfiguration.store.read().primary).toMatchObject({ provider_id: 'custom:openai' });
    expect(logLines.join('\n')).toContain(
      '✓ Provider (label="(no label)" label_state=missing role=primary match=provider_id) is now primary',
    );
    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
  });

  it('move reports the actual target and preserves the resolved entry', async () => {
    writeConfig(`primary:
  label: main
  provider_id: custom:anthropic
  api_format: anthropic
  auth_profile: ambient
  model: claude-test
  base_url: https://anthropic.test
fallbacks:
  - provider_id: custom:openai
    api_format: openai
    auth_profile: ambient
    model: gpt-test
    base_url: https://openai.test
  - label: second
    provider_id: custom:other
    api_format: openai
    auth_profile: ambient
    model: other-model
    base_url: https://other.test
`);

    await runCommand(['provider', 'move', 'custom:openai', '2']);

    expect(configDeps.llmConfiguration.store.read().fallbacks).toEqual([
      expect.objectContaining({ label: 'second', provider_id: 'custom:other' }),
      expect.objectContaining({ provider_id: 'custom:openai' }),
    ]);
    expect(logLines.join('\n')).toContain(
      '✓ Provider (label="(no label)" label_state=missing role=fallback match=provider_id) moved to fallback #2',
    );
  });

  it('move output and audit use the actual locked fallback index after clamping', async () => {
    writeConfig(`primary:
  label: main
  provider_id: custom:main
  api_format: openai
  auth_profile: ambient
  model: main-model
  base_url: https://main.test
fallbacks:
  - label: target
    provider_id: custom:target
    api_format: openai
    auth_profile: ambient
    model: target-model
    base_url: https://target.test
  - label: removed-before-lock
    provider_id: custom:middle
    api_format: openai
    auth_profile: ambient
    model: middle-model
    base_url: https://middle.test
  - label: last
    provider_id: custom:last
    api_format: openai
    auth_profile: ambient
    model: last-model
    base_url: https://last.test
`);
    let committed: ReturnType<typeof configDeps.llmConfiguration.loadRaw> | undefined;
    vi.spyOn(configDeps.llmConfiguration, 'mutateGlobalLocked').mockImplementation(async mutator => {
      const fresh = configDeps.llmConfiguration.loadRaw();
      fresh.llm.fallbacks!.splice(1, 1);
      mutator(fresh);
      committed = fresh;
      return { kind: 'durable' };
    });

    await runCommand(['provider', 'move', 'target', '3']);

    if (!committed) throw new Error('move fixture did not commit');
    expect(committed.llm.fallbacks?.map(entry => entry.label)).toEqual(['last', 'target']);
    expect(logLines.join('\n')).toContain('moved to fallback #2');
    expect(logLines.join('\n')).not.toContain('moved to fallback #3');
    const audit = fs.readFileSync(path.join(tempDir, '.chestnut', 'audit.tsv'), 'utf8');
    expect(audit).toContain('command=provider_move');
    expect(audit).toContain('position=2');
    expect(audit).not.toContain('position=3');
  });

  it('list displays no-label facts for primary and fallback rows', async () => {
    writeConfig(`primary:
  provider_id: custom:anthropic
  api_format: anthropic
  auth_profile: ambient
  model: claude-test
  base_url: https://anthropic.test
fallbacks:
  - provider_id: custom:openai
    api_format: openai
    auth_profile: ambient
    model: gpt-test
    base_url: https://openai.test
  - label: named
    provider_id: custom:other
    api_format: openai
    auth_profile: ambient
    model: other-model
    base_url: https://other.test
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

  it('list redacts primary and fallback URLs on a wide terminal without changing config bytes', async () => {
    writeConfig(`primary:
  provider_id: custom:main
  api_format: openai
  auth_profile: ambient
  model: main-model
  base_url: 'https://primary-user:primary-password@primary.test/v1?token=primary-query#primary-fragment'
fallbacks:
  - provider_id: custom:fallback
    api_format: openai
    auth_profile: ambient
    model: fallback-model
    base_url: 'https://fallback-user:fallback-password@fallback.test/v1?signature=fallback-signature&token=fallback-query#fallback-fragment'
`);
    const before = fs.readFileSync(configPath(), 'utf8');
    const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { value: 240, configurable: true });
    try {
      await runCommand(['provider', 'list']);
    } finally {
      if (originalColumns) Object.defineProperty(process.stdout, 'columns', originalColumns);
      else Reflect.deleteProperty(process.stdout, 'columns');
    }

    const output = logLines.join('\n');
    expect(output).toContain('https://primary.test/v1');
    expect(output).toContain('https://fallback.test/v1');
    for (const secret of [
      'primary-user', 'primary-password', 'primary-query', 'primary-fragment',
      'fallback-user', 'fallback-password', 'fallback-signature', 'fallback-query', 'fallback-fragment',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before);
  });

  it('explicitly rejects an existing sentinel-shaped label instead of silently migrating it', async () => {
    writeConfig(`primary:
  label: '(no label)'
  provider_id: custom:main
  api_format: openai
  auth_profile: ambient
  model: main-model
  base_url: https://main.test
fallbacks: []
`);
    const before = fs.readFileSync(configPath(), 'utf8');

    const errors = await runFailure(['provider', 'list']);

    expect(errors).toContain('Legacy LLM migration invalid_mapping at primary');
    expect(errors).toContain('mapped provider does not satisfy the explicit schema');
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before);
  });
});
