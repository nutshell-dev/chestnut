import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRootConfig } from '../../src/assembly/index.js';
import {
  createLLMConfiguration,
  isCredentialReference,
} from '../../src/core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../../src/core/llm-configuration/setup.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const configDeps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
  llmConfiguration: createLLMConfiguration({ fsFactory }),
};
const { answers, probe } = vi.hoisted(() => ({
  answers: { queue: [] as string[] },
  probe: vi.fn(),
}));
const mockRl = {
  question: vi.fn((_prompt: string, callback: (answer: string) => void) => {
    callback(answers.queue.shift() ?? '');
  }),
  close: vi.fn(),
  _writeToOutput: undefined as unknown,
};
vi.mock('readline', () => ({ createInterface: vi.fn(() => mockRl) }));
vi.mock('../../src/cli/llm-probe.js', () => ({
  probeLLMConnection: probe,
  formatLLMError: vi.fn().mockReturnValue([]),
  LLM_ERROR_HINTS: {},
  LLM_ERROR_LABELS: {},
  classifyLLMErrorForDisplay: vi.fn().mockReturnValue('unknown'),
}));

const { createConfigCommand } = await import('../../src/cli/commands/config.js');
let tempDir: string;
let output: string[];
let errors: string[];

function configPath(): string {
  return path.join(tempDir, '.chestnut', 'llm', 'config.yaml');
}

function writeConfig(primaryLabel = 'main'): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), '{}\n');
  fs.writeFileSync(configPath(), `schema_version: 1
revision: 1
primary:
  provider_id: custom:anthropic
  api_format: anthropic
  auth_profile: api_key
  api_key: \${PHASE2221_REPAIR_MISSING}
  model: original-model
  label: ${primaryLabel}
  base_url: https://primary.example.test
  extra_headers:
    X-Test: \${PHASE2221_REPAIR_HEADER}
fallbacks:
  - provider_id: custom:openai
    api_format: openai
    auth_profile: api_key
    api_key: \${PHASE2221_REPAIR_MISSING}
    model: fallback-model
    label: fallback
    base_url: https://fallback.example.test/v1
`);
}

beforeEach(() => {
  tempDir = createTrackedTempDirSync('chestnut-provider-repair-cli-');
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  vi.stubEnv('PHASE2221_REPAIR_MISSING', undefined);
  vi.stubEnv('PHASE2221_REPAIR_HEADER', 'header-value');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  writeConfig();
  answers.queue = [];
  probe.mockReset();
  output = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanupTempDirSync(tempDir);
});

describe('config provider repair', () => {
  it('缺 key 时原位修复 primary，保留 slot/header/旧 fallback 并报告全局未就绪', async () => {
    probe.mockResolvedValue({ ok: true, model: 'original-model', identity: 'probe' });
    answers.queue = ['2', 'new-primary-secret'];

    await createConfigCommand(configDeps).parseAsync(['node', 'test', 'provider', 'repair', 'main']);

    const document = configDeps.llmConfiguration.store.read();
    expect(document.revision).toBe(2);
    expect(document.primary.model).toBe('original-model');
    expect(document.primary.extra_headers).toEqual({ 'X-Test': '${PHASE2221_REPAIR_HEADER}' });
    expect(document.primary.api_key).not.toBe('${PHASE2221_REPAIR_MISSING}');
    expect(isCredentialReference(document.primary.api_key)).toBe(true);
    expect(document.fallbacks?.map(entry => entry.label)).toEqual(['fallback']);
    expect(document.fallbacks?.[0]?.api_key).toBe('${PHASE2221_REPAIR_MISSING}');
    const ref = String(document.primary.api_key).slice(2, -1);
    expect(createAuthenticationSetup({ fsFactory }).resolveSync(ref)?.accessToken).toBe('new-primary-secret');
    expect(probe).toHaveBeenCalledOnce();
    expect(errors.join('\n')).toContain('full LLM configuration is not ready');
    const evidence = fs.readFileSync(configPath(), 'utf8') + output.join('\n') + errors.join('\n');
    expect(evidence).not.toContain('new-primary-secret');
  });

  it('probe 失败后取消不提交，并清理本次新建 credential', async () => {
    probe.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'custom', identity: 'probe' });
    answers.queue = ['2', 'temporary-secret', 'n'];
    const before = fs.readFileSync(configPath(), 'utf8');

    await createConfigCommand(configDeps).parseAsync(['node', 'test', 'provider', 'repair', 'main']);

    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before);
    expect(probe).toHaveBeenCalledOnce();
    const credentialsPath = path.join(tempDir, '.chestnut', 'llm', 'credentials.yaml');
    expect(fs.existsSync(credentialsPath) ? fs.readFileSync(credentialsPath, 'utf8') : '')
      .not.toContain('temporary-secret');
  });

  it('fallback 原位更新且不改变顺序，primary 的共享旧 ref 不被覆盖', async () => {
    probe.mockResolvedValue({ ok: true, model: 'fallback-model', identity: 'probe' });
    answers.queue = ['2', 'fallback-secret'];

    await createConfigCommand(configDeps).parseAsync(['node', 'test', 'provider', 'repair', 'fallback']);

    const document = configDeps.llmConfiguration.store.read();
    expect(document.primary.api_key).toBe('${PHASE2221_REPAIR_MISSING}');
    expect(document.fallbacks).toHaveLength(1);
    expect(document.fallbacks?.[0]?.label).toBe('fallback');
    expect(document.fallbacks?.[0]?.api_key).not.toBe('${PHASE2221_REPAIR_MISSING}');
  });

  it('无 label 的单条 primary 可按唯一 provider_id 修复', async () => {
    fs.writeFileSync(configPath(), `schema_version: 1
revision: 1
primary:
  provider_id: custom:anthropic
  api_format: anthropic
  auth_profile: api_key
  api_key: \${PHASE2221_REPAIR_MISSING}
  model: original-model
  base_url: https://primary.example.test
`);
    vi.stubEnv('PHASE2221_REPAIR_MISSING', 'existing-secret');
    probe.mockResolvedValue({ ok: true, model: 'original-model', identity: 'probe' });
    answers.queue = ['3', 'repaired-model'];

    await createConfigCommand(configDeps).parseAsync([
      'node', 'test', 'provider', 'repair', 'custom:anthropic',
    ]);

    const document = configDeps.llmConfiguration.store.read();
    expect(document.primary.model).toBe('repaired-model');
    expect(document.primary.api_key).toBe('${PHASE2221_REPAIR_MISSING}');
    expect(document.fallbacks).toBeUndefined();
  });
});
