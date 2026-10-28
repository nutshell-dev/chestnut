import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { createRootConfig } from '../../src/assembly/index.js';
import { LAUNCHER_SETUP_PROTOCOL, parseLauncherSetupRequest } from '../../src/cli-protocol/launcher-setup.js';

const probe = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../src/cli/llm-connection-check.js', () => ({
  probeLLMConnection: probe.fn,
  checkLLMConnectionFor: vi.fn(),
  classifyLLMError: vi.fn(() => 'unknown'),
  summarizeLLMFailure: (failure: Record<string, unknown>) => ({ ...failure, repairActions: ['retry', 'edit', 'cancel'] }),
  formatLLMError: vi.fn(),
}));

const { executeLauncherSetup } = await import('../../src/cli/commands/launcher-setup.js');
const { buildInitialConfig } = await import('../../src/cli/first-run-setup.js');
const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
let root: string;
let deps: ReturnType<typeof makeDeps>;
let requestCounter = 0;

function makeDeps() { return { fsFactory, rootConfig: createRootConfig({ fsFactory }) }; }
function request(action: 'status' | 'select_provider' | 'submit' | 'retry' | 'cancel', payload?: Record<string, unknown>) {
  return {
    protocolVersion: LAUNCHER_SETUP_PROTOCOL,
    requestId: `req-${++requestCounter}`,
    action,
    ...(payload !== undefined && { payload }),
  };
}
function sessionPath() { return path.join(root, '.chestnut', 'launcher-setup-session.json'); }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2011-setup-'));
  process.env.CHESTNUT_ROOT = root;
  process.env.CHESTNUT_HOME = path.join(root, 'home');
  delete process.env.OPENAI_API_KEY;
  deps = makeDeps();
  probe.fn.mockReset();
  probe.fn.mockImplementation(async (snapshot: { config: { primary: { model: string } } }) => ({ ok: true, model: snapshot.config.primary.model }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('launcher setup.v1', () => {
  it('validates the versioned request and exposes the shared provider catalog', async () => {
    expect(parseLauncherSetupRequest(JSON.stringify(request('status'))).action).toBe('status');
    const response = await executeLauncherSetup(deps, request('status'));
    expect(response.kind).toBe('state');
    expect(response.payload.phase).toBe('needs_provider');
    expect(response.payload.catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openai' }),
      expect.objectContaining({ id: 'kimi', description: 'Moonshot' }),
      expect.objectContaining({ id: 'qwen', description: 'Qwen / DashScope' }),
      expect.objectContaining({ id: 'glm', description: 'Zhipu / Z.AI' }),
    ]));
  });

  it('stores keys only through credentials, commits after probe, and never serializes the secret', async () => {
    await executeLauncherSetup(deps, request('select_provider', { providerId: 'openai' }));
    const secret = 'sk-phase2011-super-secret';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await executeLauncherSetup(deps, request('submit', { model: 'gpt-test', apiKey: secret }));
    expect(log).not.toHaveBeenCalled();
    expect(response.kind).toBe('committed');
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(fs.existsSync(sessionPath())).toBe(false);
    expect(fs.readFileSync(path.join(root, '.chestnut', 'config.yaml'), 'utf8')).not.toContain(secret);
    expect(probe.fn).toHaveBeenCalledOnce();
    expect((await executeLauncherSetup(deps, request('status'))).payload.phase).toBe('committed');
  });

  it('persists a repair session without secrets and retries the same verified draft', async () => {
    await executeLauncherSetup(deps, request('select_provider', { providerId: 'openai' }));
    probe.fn.mockResolvedValueOnce({ ok: false, errorType: 'auth', message: 'bad key', provider: 'openai' });
    const secret = 'sk-repair-secret';
    const failed = await executeLauncherSetup(deps, request('submit', { model: 'gpt-test', apiKey: secret }));
    expect(failed.payload.phase).toBe('repair');
    expect(fs.readFileSync(sessionPath(), 'utf8')).not.toContain(secret);
    const restarted = makeDeps();
    expect((await executeLauncherSetup(restarted, request('status'))).payload.phase).toBe('repair');
    const committed = await executeLauncherSetup(restarted, request('retry'));
    expect(committed.kind).toBe('committed');
    expect(probe.fn).toHaveBeenCalledTimes(2);
  });

  it('cancel removes the session and newly created credential without publishing config', async () => {
    await executeLauncherSetup(deps, request('select_provider', { providerId: 'openai' }));
    probe.fn.mockResolvedValueOnce({ ok: false, errorType: 'network', message: 'offline', provider: 'openai' });
    await executeLauncherSetup(deps, request('submit', { model: 'gpt-test', apiKey: 'sk-cancel-secret' }));
    const response = await executeLauncherSetup(deps, request('cancel'));
    expect(response.payload.phase).toBe('needs_provider');
    expect(fs.existsSync(sessionPath())).toBe(false);
    expect(fs.existsSync(path.join(root, '.chestnut', 'config.yaml'))).toBe(false);
    const credentials = path.join(process.env.CHESTNUT_HOME!, '.chestnut', 'credentials.json');
    if (fs.existsSync(credentials)) expect(fs.readFileSync(credentials, 'utf8')).not.toContain('sk-cancel-secret');
  });

  it('redacts provider failures that echo the submitted secret', async () => {
    await executeLauncherSetup(deps, request('select_provider', { providerId: 'openai' }));
    const secret = 'sk-echo-secret';
    probe.fn.mockResolvedValueOnce({ ok: false, errorType: 'auth', message: `rejected ${secret}`, provider: 'openai' });
    const entries: string[][] = [];
    const audit = {
      __brand: 'AuditLog' as const,
      write: vi.fn((...cols: string[]) => entries.push(cols)),
      preview: (value: string) => value,
      message: (value: string) => value,
      summary: (value: string) => value,
      artifact: vi.fn(), loss: vi.fn(),
    };
    const response = await executeLauncherSetup(deps, request('submit', { model: 'gpt-test', apiKey: secret }), audit);
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(fs.readFileSync(sessionPath(), 'utf8')).not.toContain(secret);
  });

  it('keeps a concurrent winner instead of overwriting its verified config', async () => {
    await executeLauncherSetup(deps, request('select_provider', { providerId: 'openai' }));
    probe.fn.mockImplementationOnce(async (snapshot: { config: { primary: { model: string } } }) => {
      deps.rootConfig.saveGlobalExclusive(buildInitialConfig({ presetId: 'openai', model: 'winner-model' }));
      return { ok: true, model: snapshot.config.primary.model };
    });
    const response = await executeLauncherSetup(deps, request('submit', { model: 'loser-model', apiKey: 'sk-race' }));
    expect(response).toMatchObject({ kind: 'committed', payload: { concurrent: true } });
    expect(fs.readFileSync(path.join(root, '.chestnut', 'config.yaml'), 'utf8')).toContain('winner-model');
    expect(fs.readFileSync(path.join(root, '.chestnut', 'config.yaml'), 'utf8')).not.toContain('loser-model');
  });
});
