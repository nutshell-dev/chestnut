/**
 * contractCancelCommand integration tests (phase 1471).
 *
 * Validates: happy path, default-active resolution, error path (no active),
 * audit emit, stdout message.
 *
 * Uses CLAWFORUM_ROOT env override + real ContractSystem (no mocks of core).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsNative from 'fs';
import * as os from 'os';
import * as path from 'path';

import { contractCancelCommand } from '../../src/cli/commands/contract.js';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { CliError } from '../../src/cli/errors.js';
import { makeClawId } from '../../src/foundation/identity/index.js';
import { makeMockAudit } from '../helpers/audit.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';

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
    clawId: makeClawId(CLAW_ID),
    fs: clawFs,
    audit: makeMockAudit(),
    toolRegistry: createToolRegistry(),
    fsFactory,
  });
  return manager.create(makeContractYaml());
}

beforeEach(async () => {
  prevRoot = process.env.CLAWFORUM_ROOT;
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'phase1471-cancel-'));
  process.env.CLAWFORUM_ROOT = workspaceRoot;
  clawDir = path.join(workspaceRoot, '.clawforum', 'claws', CLAW_ID);
  await fs.mkdir(clawDir, { recursive: true });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  vi.restoreAllMocks();
  if (prevRoot === undefined) delete process.env.CLAWFORUM_ROOT;
  else process.env.CLAWFORUM_ROOT = prevRoot;
  try {
    fsNative.chmodSync(workspaceRoot, 0o700);
  } catch { /* ignore */ }
  await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
});

describe('contractCancelCommand (phase 1471)', () => {
  it('cancels contract by explicit --contract id; moves to archive with status=cancelled', async () => {
    const contractId = await seedActiveContract();
    const audit = makeMockAudit();

    await contractCancelCommand(
      { fsFactory },
      makeClawId(CLAW_ID),
      'user requested abort',
      contractId,
      { audit },
    );

    // active dir gone, archive entry present with progress.status=cancelled
    const activePath = path.join(clawDir, 'contract', 'active', contractId);
    const archivePath = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.access(activePath)).rejects.toBeTruthy();
    const progressRaw = await fs.readFile(path.join(archivePath, 'progress.json'), 'utf-8');
    const progress = JSON.parse(progressRaw);
    expect(progress.status).toBe('cancelled');
    expect(progress.checkpoint).toContain('user requested abort');

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
  });

  it('resolves active contract when --contract omitted', async () => {
    const contractId = await seedActiveContract();
    const audit = makeMockAudit();

    await contractCancelCommand(
      { fsFactory },
      makeClawId(CLAW_ID),
      'default-active cancel',
      undefined,
      { audit },
    );

    const archivePath = path.join(clawDir, 'contract', 'archive', contractId);
    const progress = JSON.parse(
      await fs.readFile(path.join(archivePath, 'progress.json'), 'utf-8'),
    );
    expect(progress.status).toBe('cancelled');
    expect(audit.write).toHaveBeenCalledWith(
      'cli_contract_cancel',
      `claw=${CLAW_ID}`,
      `contract=${contractId}`,
      'reason=default-active cancel',
    );
  });

  it('throws CliError when no active contract and --contract omitted', async () => {
    const audit = makeMockAudit();
    await expect(
      contractCancelCommand(
        { fsFactory },
        makeClawId(CLAW_ID),
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
        makeClawId(CLAW_ID),
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
