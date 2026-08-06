/**
 * Phase 1198 Step B: generic terminal lifecycle commit helper tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { commitTerminalLifecycle } from '../../../src/core/contract/lifecycle.js';
import { buildCancelledIntent, buildCompletedIntent } from '../../../src/core/contract/lifecycle-intent.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import type { LifecycleCommitOutcome } from '../../../src/core/contract/types.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = await createTempDir('test-lifecycle-commit-');
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await cleanupTempDir(tmpDir);
});

function makeCtx(overrides: { moveThrow?: Error } = {}) {
  const events: Array<{ type: string; args: string[] }> = [];
  const audit = {
    write: (type: string, ...args: string[]) => {
      events.push({ type, args });
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  function addDir(p: string) {
    let cur = p;
    while (cur && cur !== '/' && cur !== '.') {
      dirs.add(cur);
      cur = path.dirname(cur);
    }
  }
  function isDir(p: string) {
    if (dirs.has(p)) return true;
    for (const f of files.keys()) {
      if (f.startsWith(p + '/')) return true;
    }
    return false;
  }
  const mockFs = {
    exists: vi.fn(async (p: string) => files.has(p) || isDir(p)),
    existsSync: vi.fn((p: string) => files.has(p) || isDir(p)),
    read: vi.fn(async (p: string) => {
      if (!files.has(p)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p)!;
    }),
    writeExclusive: vi.fn(async (p: string, content: string) => {
      if (files.has(p)) {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      addDir(path.dirname(p));
      files.set(p, content);
    }),
    writeAtomic: vi.fn(async (p: string, content: string) => {
      addDir(path.dirname(p));
      files.set(p, content);
    }),
    ensureDir: vi.fn(async (p: string) => {
      addDir(p);
    }),
    move: vi.fn(async (src: string, dst: string) => {
      if (overrides.moveThrow) throw overrides.moveThrow;
      const srcDir = isDir(src);
      const entries: Array<[string, string]> = [];
      if (srcDir) {
        for (const [k, v] of files.entries()) {
          if (k === src || k.startsWith(src + '/')) {
            entries.push([k, v]);
          }
        }
      } else if (files.has(src)) {
        entries.push([src, files.get(src)!]);
      }
      if (entries.length === 0) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      for (const [k, v] of entries) {
        const relative = k.slice(src.length);
        const newKey = dst + relative;
        addDir(path.dirname(newKey));
        files.set(newKey, v);
        files.delete(k);
      }
      dirs.delete(src);
      addDir(dst);
    }),
    moveDir: vi.fn(async (src: string, dst: string) => {
      if (overrides.moveThrow) throw overrides.moveThrow;
      const entries: Array<[string, string]> = [];
      for (const [k, v] of files.entries()) {
        if (k === src || k.startsWith(src + '/')) {
          entries.push([k, v]);
        }
      }
      if (entries.length === 0) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      for (const [k, v] of entries) {
        const relative = k.slice(src.length);
        const newKey = dst + relative;
        addDir(path.dirname(newKey));
        files.set(newKey, v);
        files.delete(k);
      }
      dirs.delete(src);
      addDir(dst);
    }),
    list: vi.fn(async () => []),
    listSync: vi.fn(() => []),
  } as unknown as typeof nodeFs;

  return {
    ctx: {
      fs: mockFs,
      audit: audit as any,
      baseDir: clawDir,
      activeDir: `${clawDir}/contract/active`,
      archiveDir: `${clawDir}/contract/archive` as any,
      contractDir: async () => `${clawDir}/contract/active`,
      loadContract: async () => null,
      getProgress: async () => null,
      saveProgress: async () => {},
      checkAllSubtasksCompleted: async () => true,
      abortContractVerifiers: () => {},
    },
    files,
    events,
  };
}

const contractId = makeContractId('cid-commit');

describe('commitTerminalLifecycle', () => {
  it('persists intent, moves active to archive, returns committed', async () => {
    const { ctx, files, events } = makeCtx();
    const activeRoot = `${clawDir}/contract/active/${contractId}`;
    const archiveRoot = `${clawDir}/contract/archive/completed/${contractId}`;
    await ctx.fs.writeAtomic(`${activeRoot}/contract.yaml`, 'yaml');

    const intent = buildCompletedIntent(contractId, 'req-1', 'test');
    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

    expect(outcome.kind).toBe('committed');
    expect(outcome.state).toBe('completed');
    expect(await ctx.fs.exists(archiveRoot)).toBe(true);
    expect(await ctx.fs.exists(activeRoot)).toBe(false);
    expect(events.some(e => e.type === 'contract_lifecycle_intent_persisted')).toBe(true);
  });

  it('returns already_committed when requested state already present', async () => {
    const { ctx, files } = makeCtx();
    const activeRoot = `${clawDir}/contract/active/${contractId}`;
    const archiveRoot = `${clawDir}/contract/archive/completed/${contractId}`;
    // Pre-seed archive and leave active absent so move fails then resolve sees completed
    await ctx.fs.ensureDir(`${clawDir}/contract/archive/completed`);
    await ctx.fs.writeAtomic(`${archiveRoot}/contract.yaml`, 'yaml');

    const intent = buildCompletedIntent(contractId, 'req-2', 'test');
    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

    expect(outcome.kind).toBe('already_committed');
    expect(outcome.state).toBe('completed');
  });

  it('returns lost_to_state when another terminal state won', async () => {
    const { ctx, files } = makeCtx();
    const cancelledRoot = `${clawDir}/contract/archive/cancelled/${contractId}`;
    await ctx.fs.ensureDir(`${clawDir}/contract/archive/cancelled`);
    await ctx.fs.writeAtomic(`${cancelledRoot}/contract.yaml`, 'yaml');

    const intent = buildCompletedIntent(contractId, 'req-3', 'test');
    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

    expect(outcome.kind).toBe('lost_to_state');
    expect(outcome.requested).toBe('completed');
    expect(outcome.committed).toBe('cancelled');
  });

  it('returns retryable_failure when move fails and contract remains active', async () => {
    const { ctx, files } = makeCtx({ moveThrow: new Error('disk full') });
    const activeRoot = `${clawDir}/contract/active/${contractId}`;
    await ctx.fs.writeAtomic(`${activeRoot}/contract.yaml`, 'yaml');

    const intent = buildCompletedIntent(contractId, 'req-4', 'test');
    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

    expect(outcome.kind).toBe('retryable_failure');
    expect(outcome.requested).toBe('completed');
    expect(await ctx.fs.exists(activeRoot)).toBe(true);
  });

  it('keeps loser intent when losing to another state', async () => {
    const { ctx, files } = makeCtx();
    const cancelledRoot = `${clawDir}/contract/archive/cancelled/${contractId}`;
    await ctx.fs.ensureDir(`${clawDir}/contract/archive/cancelled`);
    await ctx.fs.writeAtomic(`${cancelledRoot}/contract.yaml`, 'yaml');

    const intent = buildCompletedIntent(contractId, 'req-loser', 'test');
    await commitTerminalLifecycle(ctx, contractId, intent);

    const intentPath = `${clawDir}/contract/lifecycle-intents/${contractId}/req-loser.json`;
    expect(await ctx.fs.exists(intentPath)).toBe(true);
  });
});

/**
 * Phase 1198 Step E: the generic rename commit must never read or write
 * progress.json. `checkpoint: null` is a legacy additive payload and must
 * survive the rename byte-for-byte (no hygiene writes piggybacked on commit).
 */
const PROGRESS_BYTES = JSON.stringify({
  schema_version: 1,
  contract_id: 'cid-commit',
  status: 'running',
  subtasks: { t1: { status: 'todo' } },
  checkpoint: null,
}, null, 2);

describe('commitTerminalLifecycle: progress.json bytes survive all four outcome paths', () => {
  it('committed: archived progress bytes identical to pre-rename active bytes', async () => {
    const { ctx } = makeCtx();
    const activeRoot = `${clawDir}/contract/active/${contractId}`;
    const archiveRoot = `${clawDir}/contract/archive/completed/${contractId}`;
    await ctx.fs.writeAtomic(`${activeRoot}/contract.yaml`, 'yaml');
    await ctx.fs.writeAtomic(`${activeRoot}/progress.json`, PROGRESS_BYTES);

    const intent = buildCompletedIntent(contractId, 'req-bytes-committed', 'test');
    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

    expect(outcome.kind).toBe('committed');
    expect(await ctx.fs.read(`${archiveRoot}/progress.json`)).toBe(PROGRESS_BYTES);
  });

  it('retryable_failure: active progress bytes unchanged when move fails', async () => {
    const { ctx } = makeCtx({ moveThrow: new Error('disk full') });
    const activeRoot = `${clawDir}/contract/active/${contractId}`;
    await ctx.fs.writeAtomic(`${activeRoot}/contract.yaml`, 'yaml');
    await ctx.fs.writeAtomic(`${activeRoot}/progress.json`, PROGRESS_BYTES);

    const intent = buildCompletedIntent(contractId, 'req-bytes-retryable', 'test');
    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

    expect(outcome.kind).toBe('retryable_failure');
    expect(await ctx.fs.read(`${activeRoot}/progress.json`)).toBe(PROGRESS_BYTES);
  });

  it('already_committed: same-state archived progress bytes unchanged', async () => {
    const { ctx } = makeCtx();
    const archiveRoot = `${clawDir}/contract/archive/completed/${contractId}`;
    await ctx.fs.ensureDir(`${clawDir}/contract/archive/completed`);
    await ctx.fs.writeAtomic(`${archiveRoot}/contract.yaml`, 'yaml');
    await ctx.fs.writeAtomic(`${archiveRoot}/progress.json`, PROGRESS_BYTES);

    const intent = buildCompletedIntent(contractId, 'req-bytes-already', 'test');
    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

    expect(outcome.kind).toBe('already_committed');
    expect(await ctx.fs.read(`${archiveRoot}/progress.json`)).toBe(PROGRESS_BYTES);
  });

  it('lost_to_state: winner-state archived progress bytes unchanged', async () => {
    const { ctx } = makeCtx();
    const cancelledRoot = `${clawDir}/contract/archive/cancelled/${contractId}`;
    await ctx.fs.ensureDir(`${clawDir}/contract/archive/cancelled`);
    await ctx.fs.writeAtomic(`${cancelledRoot}/contract.yaml`, 'yaml');
    await ctx.fs.writeAtomic(`${cancelledRoot}/progress.json`, PROGRESS_BYTES);

    const intent = buildCompletedIntent(contractId, 'req-bytes-lost', 'test');
    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

    expect(outcome.kind).toBe('lost_to_state');
    expect(await ctx.fs.read(`${cancelledRoot}/progress.json`)).toBe(PROGRESS_BYTES);
  });
});

/**
 * Phase 1198 Step E: compile fixture — after `kind` narrowing, variant-foreign
 * fields must be inaccessible. If the union ever widens back into optional
 * fields, these `@ts-expect-error` directives stop matching and typecheck fails.
 */
describe('LifecycleCommitOutcome discriminated narrowing (compile fixture)', () => {
  it('variant-foreign fields are inaccessible after kind narrowing', () => {
    // Laundered through a function return so control-flow narrowing cannot pin
    // the value to one variant; the point is compile-time field accessibility.
    const makeOutcome = (): LifecycleCommitOutcome => ({
      kind: 'retryable_failure',
      requested: 'completed',
      requestId: 'req-type-fixture',
      cause: 'fixture',
    });
    const outcome = makeOutcome();
    if (outcome.kind === 'retryable_failure') {
      // @ts-expect-error retryable_failure carries no final state
      void outcome.state;
      // @ts-expect-error retryable_failure carries no committed field
      void outcome.committed;
    }
    if (outcome.kind === 'committed') {
      // @ts-expect-error committed carries no failure cause
      void outcome.cause;
    }
    if (outcome.kind === 'already_committed') {
      // @ts-expect-error already_committed carries no failure cause
      void outcome.cause;
    }
    if (outcome.kind === 'lost_to_state') {
      // @ts-expect-error lost_to_state carries no state field (only committed)
      void outcome.state;
    }
    expect(outcome.kind).toBe('retryable_failure');
  });
});
