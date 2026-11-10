/**
 * contractCancelCommand integration tests (phase 1471).
 *
 * Validates: happy path, default-active resolution, error path (no active),
 * audit emit, stdout message.
 *
 * Uses CHESTNUT_ROOT env override + real ContractSystem (no mocks of core).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsNative from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

import { contractCancelCommand } from '../../src/cli/commands/contract.js';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { CliError } from '../../src/cli/errors.js';
import { makeMockAudit } from '../helpers/audit.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { readLifecycleIntentsForContract } from '../../src/core/contract/lifecycle-intent.js';
import * as assembly from '../../src/assembly/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const CLAW_ID = 'test-cancel-claw';

let workspaceRoot: string;
let clawDir: string;
let prevRoot: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

async function seedActiveContract(): Promise<string> {
  const clawFs = new NodeFileSystem({ baseDir: clawDir });
  const manager = new ContractSystem({
    clawDir,
    clawId: CLAW_ID,
    fs: clawFs,
    audit: makeMockAudit(),
    toolRegistry: createToolRegistry(),
    fsFactory,
    clawsDir: '/tmp/test/claws',
    deliverCancellation: async () => {},
    notifyClaw: vi.fn(),});
  return manager.create(makeContractYaml());
}

beforeEach(async () => {
  prevRoot = process.env.CHESTNUT_ROOT;
  workspaceRoot = await createTrackedTempDir('phase1471-cancel-');
  process.env.CHESTNUT_ROOT = workspaceRoot;
  clawDir = path.join(workspaceRoot, '.chestnut', 'claws', CLAW_ID);
  await fs.mkdir(clawDir, { recursive: true });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  vi.restoreAllMocks();
  if (prevRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = prevRoot;
  try {
    fsNative.chmodSync(workspaceRoot, 0o700);
  } catch { /* ignore */ }
  await cleanupTempDir(workspaceRoot);
});

describe('contractCancelCommand (phase 1471)', () => {
  it('cancels contract by explicit --contract id; moves to archive with status=cancelled', async () => {
    const contractId = await seedActiveContract();
    const audit = makeMockAudit();

    await contractCancelCommand(
      { fsFactory },
      CLAW_ID,
      'user requested abort',
      contractId,
      { audit },
    );

    // active dir gone, archive/cancelled entry present
    const activePath = path.join(clawDir, 'contract', 'active', contractId);
    const archivePath = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    await expect(fs.access(activePath)).rejects.toBeTruthy();
    const progressRaw = await fs.readFile(path.join(archivePath, 'progress.json'), 'utf-8');
    const progress = JSON.parse(progressRaw);
    expect(progress.status).toBeUndefined();
    // Phase 1198 Step E: terminal commit performs zero progress mutation.
    expect(progress.checkpoint).toBeNull();

    const clawFs = new NodeFileSystem({ baseDir: clawDir });
    const { intents } = await readLifecycleIntentsForContract(
      clawFs,
      audit,
      clawDir,
      contractId,
    );
    expect(intents.some(i => i.requested_state === 'cancelled' && (i as { reason: string }).reason === 'user requested abort')).toBe(true);

    // CLI audit emit
    expect(audit.write).toHaveBeenCalledWith(
      'cli_contract_cancel',
      `claw=${CLAW_ID}`,
      `contract=${contractId}`,
      'reason=user requested abort',
    );

    // stdout
    expect(logSpy).toHaveBeenCalledWith(
      `Contract cancelled: ${contractId} (reason: user requested abort)`,
    );

    // Phase 2091: 真实 CLI 装配由 owner 经 throwing Messaging 投递，不依赖 onNotify。
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    const inboxFiles = await fs.readdir(pendingDir);
    expect(inboxFiles).toHaveLength(1);
    const message = await fs.readFile(path.join(pendingDir, inboxFiles[0]), 'utf8');
    expect(message).toContain('id: contract:' + contractId + ':cancelled');
    expect(message).toContain('type: contract_cancelled');
    expect(message).toContain('from: "system"');
    expect(message).toContain('priority: high');
    expect(message).toContain('取消原因：user requested abort');
    expect(message).toContain(
      `cancelled_contract_refs: "[{\\"claw_id\\":\\"${CLAW_ID}\\",\\"contract_id\\":\\"${contractId}\\"}]"`,
    );
  });

  it('resolves active contract when --contract omitted', async () => {
    const contractId = await seedActiveContract();
    const audit = makeMockAudit();

    await contractCancelCommand(
      { fsFactory },
      CLAW_ID,
      'default-active cancel',
      undefined,
      { audit },
    );

    const archivePath = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    const progress = JSON.parse(
      await fs.readFile(path.join(archivePath, 'progress.json'), 'utf-8'),
    );
    expect(progress.status).toBeUndefined();
    // Phase 1198 Step E: terminal commit performs zero progress mutation.
    expect(progress.checkpoint).toBeNull();
    expect(audit.write).toHaveBeenCalledWith(
      'cli_contract_cancel',
      `claw=${CLAW_ID}`,
      `contract=${contractId}`,
      'reason=default-active cancel',
    );
  });

  it('reports an already-cancelled contract without claiming delivery was checked', async () => {
    const contractId = await seedActiveContract();
    const audit = makeMockAudit();
    await contractCancelCommand({ fsFactory }, CLAW_ID, 'first', contractId, { audit });
    logSpy.mockClear();

    await contractCancelCommand({ fsFactory }, CLAW_ID, 'second', contractId, { audit });

    expect(logSpy).toHaveBeenCalledWith(
      `Contract already cancelled: ${contractId} (notification delivery not checked)`,
    );
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('delivery failed'));
    const archivePath = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    await expect(fs.access(archivePath)).resolves.toBeUndefined();
  });

  it('reports committed cancellation with the original inbox failure and preserves the archive', async () => {
    const contractId = await seedActiveContract();
    const audit = makeMockAudit();
    const failure = new Error('INBOX_WRITE_EIO');
    const failingFsFactory = (dir: string): FileSystem => {
      const nodeFs = new NodeFileSystem({ baseDir: dir });
      return new Proxy(nodeFs as unknown as FileSystem, {
        get(target, prop) {
          if (prop === 'writeAtomicSync') {
            return (relativePath: string, content: string) => {
              if (relativePath.includes(`${path.sep}inbox${path.sep}pending${path.sep}`)) {
                throw failure;
              }
              return nodeFs.writeAtomicSync(relativePath, content);
            };
          }
          const value = Reflect.get(target as object, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    let caught: unknown;
    try {
      await contractCancelCommand(
        { fsFactory: failingFsFactory },
        CLAW_ID,
        'stop but inbox fails',
        contractId,
        { audit },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect((caught as Error).message).toBe(
      `Contract cancelled: ${contractId}; cancellation notification delivery failed`,
    );
    expect((caught as Error).message).not.toContain('Failed to cancel');
    expect((caught as Error & { cause?: unknown }).cause).toBe(failure);
    expect(logSpy).not.toHaveBeenCalledWith(
      `Contract cancelled: ${contractId} (reason: stop but inbox fails)`,
    );
    const archivePath = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    await expect(fs.access(archivePath)).resolves.toBeUndefined();
    await expect(fs.access(path.join(clawDir, 'contract', 'active', contractId))).rejects.toBeTruthy();
    expect(audit.write).toHaveBeenCalledWith(
      'cli_contract_cancel',
      `claw=${CLAW_ID}`,
      `contract=${contractId}`,
      'reason=stop but inbox fails',
    );
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    const pendingFiles = fsNative.existsSync(pendingDir) ? await fs.readdir(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('treats committed plus not_attempted as a defensive error and always disposes', async () => {
    const dispose = vi.fn();
    const cancel = vi.fn(async () => ({
      commit: { kind: 'committed' },
      cancellationDelivery: { kind: 'not_attempted' },
    }));
    vi.spyOn(assembly, 'createContractActionContext').mockResolvedValueOnce({
      system: { cancel },
      dispose,
    } as unknown as assembly.ContractActionContext);

    await expect(contractCancelCommand(
      { fsFactory },
      CLAW_ID,
      'inconsistent owner result',
      'contract-1',
    )).rejects.toThrow(
      'Contract cancelled: contract-1; cancellation notification was not attempted',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('throws CliError when no active contract and --contract omitted', async () => {
    const audit = makeMockAudit();
    await expect(
      contractCancelCommand(
        { fsFactory },
        CLAW_ID,
        'r',
        undefined,
        { audit },
      ),
    ).rejects.toBeInstanceOf(CliError);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('wraps lower-level errors as CliError with cause chain when contract not found', async () => {
    const audit = makeMockAudit();
    let caught: unknown;
    try {
      await contractCancelCommand(
        { fsFactory },
        CLAW_ID,
        'r',
        'no-such-contract-id',
        { audit },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as Error).message).toContain('no-such-contract-id');
    expect((caught as Error & { cause?: unknown }).cause).toBeDefined();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
