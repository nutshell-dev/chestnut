import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startCommand } from '../../src/cli/commands/start.js';
import { executeLauncherStart } from '../../src/cli/commands/launcher-start.js';
import {
  LAUNCHER_CAPABILITIES,
  parseLauncherStartRequest,
} from '../../src/cli-protocol/index.js';

const h = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  onboardingStatus: vi.fn(),
  chat: vi.fn(),
  readDaemon: vi.fn(),
}));

vi.mock('../../src/cli/start-bootstrap.js', () => ({
  ensureStartBootstrap: h.bootstrap,
  getOnboardingStatus: h.onboardingStatus,
}));
vi.mock('../../src/cli/commands/motion.js', () => ({ chatCommand: h.chat }));
vi.mock('../../src/cli/commands/launcher-runtime.js', () => ({ readLauncherDaemon: h.readDaemon }));
vi.mock('../../src/cli/first-run-setup.js', () => ({
  runFirstRunSetup: vi.fn(),
  runNonInteractiveFirstRun: vi.fn(),
}));
vi.mock('../../src/cli/start-llm-gate.js', () => ({
  START_GATE_EXIT_CODE: 3,
  applyStartLLMOptions: vi.fn(),
  validateStartLLMOptions: vi.fn(),
}));

const deps = {
  fsFactory: vi.fn(),
  rootConfig: { getInitializationState: vi.fn(() => 'ready') },
} as never;
const runtime = { ensureSupervision: vi.fn(async () => {}) };

describe('start / launcher start shared bootstrap parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.onboardingStatus.mockReturnValue({ state: 'not_found' });
    h.bootstrap.mockResolvedValue({
      verified: {},
      daemon: { state: 'running' },
      onboarding: { state: 'created', contractId: 'onboarding' },
    });
    h.readDaemon.mockReturnValue({ state: 'running' });
    h.chat.mockResolvedValue(undefined);
  });

  it('both adapters await the same auto bootstrap before chat or ready', async () => {
    await startCommand(deps, runtime, { nonInteractive: true });
    const launcher = await executeLauncherStart(deps, {}, runtime);

    expect(h.bootstrap).toHaveBeenCalledTimes(2);
    for (const call of h.bootstrap.mock.calls) {
      expect(call[2]).toMatchObject({
        interactive: false,
        languageMode: 'auto',
        firstRun: false,
        onboarding: { state: 'not_found' },
      });
      expect(call[2].resolveLanguage).toBeUndefined();
    }
    expect(h.bootstrap.mock.invocationCallOrder[0]).toBeLessThan(h.chat.mock.invocationCallOrder[0]);
    expect(launcher).toMatchObject({
      kind: 'daemon',
      payload: { state: 'running', detail: 'ready', onboarding: 'created' },
    });
  });

  it('launcher start accepts a CLI-style language sample and defaults to auto', () => {
    expect(LAUNCHER_CAPABILITIES.languageMode).toBe('prompt_or_auto');
    expect(parseLauncherStartRequest('{"command":"start","timeoutMs":1000}')).toEqual({
      command: 'start', timeoutMs: 1000,
    });
    expect(parseLauncherStartRequest('{"command":"start","languageSample":"你好"}')).toEqual({
      command: 'start', languageSample: '你好',
    });
    expect(() => parseLauncherStartRequest('{"command":"start","languageSample":42}'))
      .toThrow(/languageSample/);
  });

  it('forwards the language sample to shared onboarding without UI-side inference', async () => {
    await executeLauncherStart(deps, { languageSample: '你好' }, runtime);
    expect(h.bootstrap.mock.calls[0][2]).toMatchObject({
      languageMode: 'auto', languageSample: '你好',
    });
  });
});
