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

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// Mock config
vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    loadGlobalConfig: vi.fn(),
    getGlobalConfigPath: vi.fn(),
    clawExists: vi.fn(() => true),
  };
});

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
    const { sendCommand } = await import('../../src/cli/commands/claw-send.js');
    const { getGlobalConfigPath } = await import('../../src/foundation/config/index.js');
    const { createProcessManagerForCLI } = await import('../../src/foundation/process-manager/index.js');

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
    const { sendCommand } = await import('../../src/cli/commands/claw-send.js');
    const { getGlobalConfigPath } = await import('../../src/foundation/config/index.js');
    const { createProcessManagerForCLI } = await import('../../src/foundation/process-manager/index.js');

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
    const { sendCommand } = await import('../../src/cli/commands/claw-send.js');
    const { getGlobalConfigPath } = await import('../../src/foundation/config/index.js');
    const { createProcessManagerForCLI } = await import('../../src/foundation/process-manager/index.js');

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
    const { formatClawStatusHint } = await import('../../src/cli/commands/claw-shared.js');

    expect(formatClawStatusHint('my-claw', false)).toBe(
      'Note: claw "my-claw" is not running. Start it with: chestnut claw my-claw daemon',
    );
    expect(formatClawStatusHint('my-claw', true)).toBeUndefined();
  });
});
