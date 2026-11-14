import * as path from 'path';
import * as fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { ProcessListUnavailable } from '../../../src/foundation/process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import {
  getOrphanCleanupActiveDir,
  getOrphanCleanupRetiredDir,
  runOrphanCleanup,
} from '../../../src/foundation/process-manager/orphan-cleanup.js';
import type {
  ProcessManagerContext,
  SpawnOptions,
} from '../../../src/foundation/process-manager/types.js';
import { makeAudit } from '../../helpers/audit.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0 };
});

const processList = vi.hoisted(() => ({
  impl: (() => Promise.resolve([])) as () => Promise<Array<{ pid: number; command: string }>>,
}));
describe('durable orphan cleanup recovery', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('orphan-cleanup-recovery-');
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    processList.impl = () => Promise.resolve([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    processList.impl = () => Promise.resolve([]);
    await cleanupTempDir(tempDir);
  });

  function setup(clawId = 'claw-a') {
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    const { audit, events } = makeAudit();
    const ctx = {
      fs: nodeFs,
      audit,
      kill: vi.fn(),
    } as unknown as ProcessManagerContext;
    const options: SpawnOptions = {
      command: 'node',
      args: ['/fake/daemon entry.js', clawId],
      logFile: path.join(daemonDir, 'logs', 'daemon.log'),
    };
    return { daemonDir, ctx, options, events };
  }

  async function readJson(file: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  }

  function run(
    ctx: ProcessManagerContext,
    daemonDir: Parameters<typeof runOrphanCleanup>[1],
    options: SpawnOptions,
  ): ReturnType<typeof runOrphanCleanup> {
    return runOrphanCleanup(ctx, daemonDir, options, { list: () => processList.impl() });
  }

  it('persists enumerate failure with structured evidence and resumes the same request', async () => {
    const { daemonDir, ctx, options, events } = setup();
    const listError = new ProcessListUnavailable('query', new Error('pgrep missing'), {
      operation: 'pgrep',
      classification: 'spawn_error',
      code: 'ENOENT',
      stderr: 'not found\n',
    });
    processList.impl = () => Promise.reject(listError);

    const first = await run(ctx, daemonDir, options);
    expect(first).toMatchObject({ kind: 'blocked', stage: 'enumerate', error: listError });
    const requestId = first.kind === 'blocked' ? first.requestId : undefined;
    expect(requestId).toBeDefined();
    expect(ctx.kill).not.toHaveBeenCalled();
    expect(ctx.fs.existsSync(getOrphanCleanupActiveDir(daemonDir))).toBe(true);
    const outcome = await readJson(path.join(getOrphanCleanupActiveDir(daemonDir), 'outcome.json'));
    expect(outcome).toMatchObject({
      schema_version: 1,
      request_id: requestId,
      outcome: 'blocked',
      stage: 'enumerate',
      error: { code: 'PROCESS_LIST_UNAVAILABLE', evidence: { code: 'ENOENT', stderr: 'not found\n' } },
    });

    processList.impl = () => Promise.resolve([]);
    const second = await run(ctx, daemonDir, options);
    expect(second).toEqual({
      kind: 'not_needed', requestId, recovered: true,
    });
    expect(ctx.fs.existsSync(getOrphanCleanupActiveDir(daemonDir))).toBe(false);
    const retired = getOrphanCleanupRetiredDir(daemonDir, requestId!);
    expect(await readJson(path.join(retired, 'intent.json'))).toMatchObject({
      request_id: requestId,
      command: options.command,
      args: options.args,
    });
    expect(events.map(event => event[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_CLEANUP_RECOVERED);
  });

  it('matches all production argv tokens literally and skips a sibling claw', async () => {
    const { daemonDir, ctx, options } = setup('claw-a');
    let calls = 0;
    processList.impl = () => {
      calls++;
      return Promise.resolve(calls === 1 ? [
        { pid: 4101, command: 'node /fake/daemon entry.js claw-a' },
        { pid: 4102, command: 'node /fake/daemon entry.js claw-a-sibling' },
      ] : []);
    };

    const result = await run(ctx, daemonDir, options);
    expect(result).toMatchObject({ kind: 'clear', terminated: 1, recovered: false });
    expect(ctx.kill).toHaveBeenCalledTimes(1);
    expect(ctx.kill).toHaveBeenCalledWith(4101, 'TERM');
  });

  it('does not finalize or report success when outcome persistence fails', async () => {
    const { daemonDir, ctx, options } = setup();
    const writeError = new Error('disk full');
    vi.spyOn(ctx.fs, 'writeAtomicExisting').mockRejectedValueOnce(writeError);

    const first = await run(ctx, daemonDir, options);
    expect(first).toMatchObject({ kind: 'blocked', stage: 'persist', error: writeError });
    expect(ctx.fs.existsSync(getOrphanCleanupActiveDir(daemonDir))).toBe(true);
    expect(ctx.fs.existsSync(getOrphanCleanupRetiredDir(daemonDir, first.requestId!))).toBe(false);

    const second = await run(ctx, daemonDir, options);
    expect(second).toMatchObject({ kind: 'not_needed', requestId: first.requestId, recovered: true });
  });

  it('reconciles a persisted successful outcome after a finalize crash without re-listing', async () => {
    const { daemonDir, ctx, options } = setup();
    const moveError = new Error('simulated crash before rename');
    vi.spyOn(ctx.fs, 'moveDirSync').mockImplementationOnce(() => { throw moveError; });

    const first = await run(ctx, daemonDir, options);
    expect(first).toMatchObject({ kind: 'blocked', stage: 'persist', error: moveError });
    let listCalls = 0;
    processList.impl = () => {
      listCalls++;
      return Promise.resolve([]);
    };

    const second = await run(ctx, daemonDir, options);
    expect(second).toMatchObject({ kind: 'not_needed', requestId: first.requestId, recovered: true });
    expect(listCalls).toBe(0);
    expect(ctx.fs.existsSync(getOrphanCleanupRetiredDir(daemonDir, first.requestId!))).toBe(true);
  });

  it('reconciles concurrent attempts through one retired request', async () => {
    const { daemonDir, ctx, options } = setup();

    const [first, second] = await Promise.all([
      run(ctx, daemonDir, options),
      run(ctx, daemonDir, options),
    ]);

    expect(first.kind).not.toBe('blocked');
    expect(second.kind).not.toBe('blocked');
    expect(first.requestId).toBe(second.requestId);
    expect(ctx.fs.existsSync(getOrphanCleanupActiveDir(daemonDir))).toBe(false);
    expect(ctx.fs.existsSync(getOrphanCleanupRetiredDir(daemonDir, first.requestId))).toBe(true);
  });

  it('keeps malformed recovery records and fails closed without signalling', async () => {
    const { daemonDir, ctx, options } = setup();
    const active = getOrphanCleanupActiveDir(daemonDir);
    await fs.mkdir(active, { recursive: true });
    const intentFile = path.join(active, 'intent.json');
    await fs.writeFile(intentFile, '{broken', 'utf8');

    const result = await run(ctx, daemonDir, options);
    expect(result).toMatchObject({ kind: 'blocked', stage: 'persist', recovered: true });
    expect(ctx.kill).not.toHaveBeenCalled();
    expect(await fs.readFile(intentFile, 'utf8')).toBe('{broken');
  });
});
