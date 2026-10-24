/**
 * cli claw send status hint + wrapper migration tests (phase 232)
 *
 * Invariants:
 * 1. cli send uses notifyClaw wrapper (M#3 SoT)
 * 2. phase 1990：stdout 只含 launcher.v1 ack envelope；status/contract hint 一律 stderr
 * 3. formatClawStatusHint helper shared with notify_claw tool (M#1)
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
import { formatNoActiveContractHint } from '../../src/cli/commands/claw-shared.js';
import { formatClawStatusHint } from '../../src/cli-protocol/index.js';
import { makeClawCommandDeps, type FakeClawCommandDeps } from '../helpers/claw-command-deps.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// Mock config
vi.mock('../../src/assembly/config/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/global-config-path.js')>();
  return {
    ...actual,
    getGlobalConfigPath: vi.fn(),
  };
});
vi.mock('../../src/foundation/config-store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config-store/index.js')>();
  return {
    ...actual,
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
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let commandDeps: FakeClawCommandDeps;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(os.tmpdir(), `phase232-claws-${randomUUID()}`);
    // phase 232: chestnutRoot = path.dirname(getGlobalConfigPath()) = <tmpRoot>/.chestnut
    const chestnutRoot = path.join(tmpRoot, '.chestnut');
    fs.mkdirSync(path.join(chestnutRoot, 'claws', 'test-claw'), { recursive: true });
    fs.writeFileSync(path.join(chestnutRoot, 'claws', 'test-claw', 'config.yaml'), 'name: test-claw\n');
    process.env.CHESTNUT_ROOT = tmpRoot;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    commandDeps = makeClawCommandDeps(fsFactory);
  });

  afterEach(() => {
    delete process.env.CHESTNUT_ROOT;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  function stderrText(): string {
    return stderrWriteSpy.mock.calls.map(c => String(c[0])).join('');
  }

  function stdoutText(): string {
    return stdoutWriteSpy.mock.calls.map(c => String(c[0])).join('');
  }

  function stdoutEnvelopes(): any[] {
    return stdoutText().trim().split(/\n+/).filter(Boolean).map((l) => JSON.parse(l));
  }

  it('stderr 含 hint + stdout 只有 ack envelope when target claw not alive', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => false,
    } as any);

    await sendCommand(commandDeps, 'test-claw', 'hello');

    expect(stderrText()).toContain(
      'Note: claw "test-claw" is not running. Start it with: chestnut claw test-claw daemon',
    );
    expect(stdoutText()).not.toContain('Message sent');
    expect(stdoutText()).not.toContain('Note:');
    const envelopes = stdoutEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      protocolVersion: 'chestnut.launcher.v1',
      kind: 'ack',
      payload: { accepted: true, claw: 'test-claw' },
    });
  });

  it('stderr 不含 hint when target claw alive', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => true,
    } as any);

    await sendCommand(commandDeps, 'test-claw', 'hello');

    expect(stderrText()).not.toContain('Note: claw');
    expect(stdoutEnvelopes()[0]).toMatchObject({ kind: 'ack', payload: { accepted: true } });
  });

  it('uses notifyClaw wrapper — file written to target inbox', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => true,
    } as any);

    await sendCommand(commandDeps, 'test-claw', 'wrapper-msg');

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

  it('stderr 含 contract hint when no active contract (phase 241)', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => true,
    } as any);

    await sendCommand(commandDeps, 'test-claw', 'hello');

    expect(stderrText()).toContain(
      'No active contract for "test-claw". Ask claw to reply via send tool in message body.',
    );
    expect(stdoutText()).not.toContain('No active contract');
  });

  it('console.log 不含 contract hint when has active contract (phase 241)', async () => {

    // 模拟有 active contract
    fs.mkdirSync(path.join(tmpRoot, '.chestnut', 'claws', 'test-claw', 'contract', 'active', 'contract-1'), { recursive: true });

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: () => true,
    } as any);

    await sendCommand(commandDeps, 'test-claw', 'hello');

    expect(stderrText()).not.toContain('active contract');
    expect(stdoutEnvelopes()[0]).toMatchObject({ kind: 'ack' });
  });

  it('uses formatNoActiveContractHint helper (phase 241)', async () => {
    expect(formatNoActiveContractHint('my-claw', false)).toBe(
      'No active contract for "my-claw". Ask claw to reply via send tool in message body.',
    );
    expect(formatNoActiveContractHint('my-claw', true)).toBeUndefined();
  });
});
