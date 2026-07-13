/**
 * cli claw send status hint + wrapper migration tests (phase 232)
 *
 * Invariants:
 * 1. cli send uses notifyClaw wrapper (M#3 SoT)
 * 2. console.log 含 hint when target claw not alive
 * 3. console.log 不含 hint when target claw alive
 * 4. formatClawStatusHint helper shared with notify_claw tool (M#1)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
// phase 266: hoist 17 dynamic imports of 5 unique modules below.
import { sendCommand } from '../../src/cli/commands/claw-send.js';
import { getGlobalConfigPath } from '../../src/assembly/config/global-config-path.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/index.js';
import { formatClawStatusHint, formatNoActiveContractHint } from '../../src/cli/commands/claw-shared.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// Mock config
vi.mock('../../src/assembly/config/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/global-config-path.js')>();
  return {
    ...actual,
    getGlobalConfigPath: vi.fn(),
  };
});
vi.mock('../../src/assembly/config/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/config-loader.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

// Mock process manager
vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>();
  return {
    ...actual,
    createProcessManagerForCLI: vi.fn(() => ({
      isAlive: vi.fn(),
    })),
  };
});

describe('cli claw send status hint (phase 232)', () => {
  let tmpRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(os.tmpdir(), `phase232-claws-${randomUUID()}`);
    // phase 232: chestnutRoot = path.dirname(getGlobalConfigPath()) = <tmpRoot>/.chestnut
    const chestnutRoot = path.join(tmpRoot, '.chestnut');
    fs.mkdirSync(path.join(chestnutRoot, 'claws', 'test-claw'), { recursive: true });
    fs.writeFileSync(path.join(chestnutRoot, 'claws', 'test-claw', 'config.yaml'), 'name: test-claw\n');
    process.env.CHESTNUT_ROOT = tmpRoot;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CHESTNUT_ROOT;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
  });

  it('console.log 含 hint when target claw not alive', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => false,
    } as any);

    await sendCommand({ fsFactory }, 'test-claw', 'hello');

    const calls = consoleLogSpy.mock.calls.map(c => c[0]);
    expect(calls).toContain('Message sent to "test-claw"');
    expect(calls).toContain(
      'Note: claw "test-claw" is not running. Start it with: chestnut claw test-claw daemon',
    );
  });

  it('console.log 不含 hint when target claw alive', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => true,
    } as any);

    await sendCommand({ fsFactory }, 'test-claw', 'hello');

    const calls = consoleLogSpy.mock.calls.map(c => c[0]);
    expect(calls).toContain('Message sent to "test-claw"');
    expect(calls).not.toContain(
      expect.stringContaining('Note: claw'),
    );
  });

  it('uses notifyClaw wrapper — file written to target inbox', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => true,
    } as any);

    await sendCommand({ fsFactory }, 'test-claw', 'wrapper-msg');

    const inboxDir = path.join(tmpRoot, '.chestnut', 'claws', 'test-claw', 'inbox', 'pending');
    const files = fs.readdirSync(inboxDir);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    expect(content).toMatch(/wrapper-msg/);
    expect(content).toMatch(/type: user_inbox_message/);
    expect(content).toMatch(/from: "user"/);
  });

  it('uses same formatClawStatusHint helper as notify_claw tool (M#1)', async () => {

    expect(formatClawStatusHint('my-claw', false)).toBe(
      'Note: claw "my-claw" is not running. Start it with: chestnut claw my-claw daemon',
    );
    expect(formatClawStatusHint('my-claw', true)).toBeUndefined();
  });

  it('console.log 含 contract hint when no active contract (phase 241)', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => true,
    } as any);

    await sendCommand({ fsFactory }, 'test-claw', 'hello');

    const calls = consoleLogSpy.mock.calls.map(c => c[0]);
    expect(calls).toContain('Message sent to "test-claw"');
    expect(calls).toContain(
      'No active contract for "test-claw". Ask claw to reply via send tool in message body.',
    );
  });

  it('console.log 不含 contract hint when has active contract (phase 241)', async () => {

    // 模拟有 active contract
    fs.mkdirSync(path.join(tmpRoot, '.chestnut', 'claws', 'test-claw', 'contract', 'active', 'contract-1'), { recursive: true });

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => true,
    } as any);

    await sendCommand({ fsFactory }, 'test-claw', 'hello');

    const calls = consoleLogSpy.mock.calls.map(c => c[0]);
    expect(calls).toContain('Message sent to "test-claw"');
    expect(calls).not.toContain(
      expect.stringContaining('active contract'),
    );
  });

  it('uses formatNoActiveContractHint helper (phase 241)', async () => {
    expect(formatNoActiveContractHint('my-claw', false)).toBe(
      'No active contract for "my-claw". Ask claw to reply via send tool in message body.',
    );
    expect(formatNoActiveContractHint('my-claw', true)).toBeUndefined();
  });
});
