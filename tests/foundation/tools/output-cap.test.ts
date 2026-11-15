import * as nodePath from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { DEFAULT_TOOL_OUTPUT_BOUNDS } from '../../../src/foundation/tools/constants.js';
import { enforceToolResultBounds } from '../../../src/foundation/tools/output-cap.js';
import type { ExecContext, Tool, ToolOutputBounds } from '../../../src/foundation/tools/types.js';
import { makeAudit } from '../../helpers/audit.js';
import { makeExecContext } from '../../helpers/exec-context.js';

type WriteAtomic = FileSystem['writeAtomic'];
type WriteResult = Awaited<ReturnType<WriteAtomic>>;

const durable = async (): Promise<WriteResult> => ({ kind: 'durable' });
const bounds = (maxBytes = 512, maxLines = 8, artifactKind = 'test'): ToolOutputBounds => ({
  maxBytes,
  maxLines,
  artifactKind,
});

function context(writeAtomic: WriteAtomic, auditWriter?: ExecContext['auditWriter']): ExecContext {
  return makeExecContext({
    fs: { writeAtomic } as unknown as FileSystem,
    clawDir: '/caller',
    syncDir: '/caller/tasks/sync',
    workspaceDir: '/caller/clawspace',
    ...(auditWriter === undefined ? {} : { auditWriter }),
  });
}

function tool(name: string, content: string, outputBounds: ToolOutputBounds, metadata?: ToolResult['metadata']): Tool {
  return {
    name,
    description: 'output cap fixture',
    schema: { type: 'object' },
    readonly: true,
    idempotent: true,
    profiles: ['full'],
    outputBounds,
    execute: async () => ({ success: true, content, ...(metadata === undefined ? {} : { metadata }) }),
  };
}

function expectWithin(content: string, limit: ToolOutputBounds): void {
  expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(limit.maxBytes);
  expect(content.split('\n').length).toBeLessThanOrEqual(limit.maxLines);
}

describe('ToolExecutor output bounds', () => {
  it('leaves an in-bounds result object untouched and does not write', async () => {
    const writeAtomic = vi.fn<WriteAtomic>(durable);
    const raw: ToolResult = { success: true, content: 'short', metadata: { filesAffected: ['a'] } };

    const result = await enforceToolResultBounds(context(writeAtomic), 'short', raw, bounds());

    expect(result).toBe(raw);
    expect(writeAtomic).not.toHaveBeenCalled();
  });

  it('caps executor results by UTF-8 bytes after saving exact raw content, and audits the final result', async () => {
    const raw = 'x'.repeat(2_000);
    const writeAtomic = vi.fn<WriteAtomic>(durable);
    const { audit, events } = makeAudit();
    const registry = new ToolRegistryImpl();
    registry.register(tool('byte-cap', raw, bounds()));

    const result = await new ToolExecutorImpl(registry).execute({
      toolName: 'byte-cap', args: {}, ctx: context(writeAtomic, audit),
    });

    expect(result.success).toBe(true);
    expectWithin(result.content, bounds());
    expect(result.content).toContain('full output saved at ../tasks/sync/test/');
    expect(result.content).toContain('artifact=durable');
    expect(result.metadata?.output).toMatchObject({
      ownerBounded: true,
      artifact: { kind: 'durable', path: expect.stringContaining('../tasks/sync/test/') },
    });
    expect(writeAtomic).toHaveBeenCalledOnce();
    expect(writeAtomic.mock.calls[0]![0]).toMatch(/^tasks\/sync\/test\/[a-f0-9-]+\.md$/);
    expect(writeAtomic.mock.calls[0]![1]).toBe(raw);
    const finalAudit = events.find(([type]) => type === 'tool_exec');
    expect(finalAudit).toContain(`summary=${result.content}`);
  });

  it('caps by lines as well as bytes and preserves the complete footer', async () => {
    const raw = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
    const writeAtomic = vi.fn<WriteAtomic>(durable);
    const limit = bounds(2_048, 4);

    const result = await enforceToolResultBounds(
      context(writeAtomic), 'line-cap', { success: true, content: raw }, limit,
    );

    expectWithin(result.content, limit);
    expect(result.content.split('\n')).toHaveLength(4);
    expect(result.content).toContain('retrieve with read(');
    expect(writeAtomic.mock.calls[0]![1]).toBe(raw);
  });

  it('never splits a multi-byte code point in the preview', async () => {
    const raw = '🙂汉'.repeat(500);
    const writeAtomic = vi.fn<WriteAtomic>(durable);
    const limit = bounds(384, 8);

    const result = await enforceToolResultBounds(
      context(writeAtomic), 'utf8-cap', { success: true, content: raw }, limit,
    );

    expectWithin(result.content, limit);
    expect(result.content).not.toContain('\uFFFD');
    expect(result.content).toContain('full output saved at');
    expect(writeAtomic.mock.calls[0]![1]).toBe(raw);
  });
});

describe('Tool output artifact durability', () => {
  it.each([
    'durable',
    'committed_platform_limited',
    'committed_durability_unknown',
  ] as const)('preserves %s without rewriting or hiding the state', async (kind) => {
    const error = Object.assign(new Error(`injected ${kind}`), { code: 'EIO' });
    const outcome: WriteResult = kind === 'durable' ? { kind } : { kind, error };
    const writeAtomic = vi.fn<WriteAtomic>(async () => outcome);
    const { audit, events } = makeAudit();

    const result = await enforceToolResultBounds(
      context(writeAtomic, audit), 'three-state', { success: true, content: 'z'.repeat(2_000) }, bounds(),
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.output?.artifact).toMatchObject({ kind });
    expect(result.content).toContain(`artifact=${kind}`);
    expect(writeAtomic).toHaveBeenCalledOnce();
    const capEvents = events.filter(([type]) => type === 'tool_output_cap');
    expect(capEvents).toHaveLength(kind === 'durable' ? 0 : 1);
    if (kind !== 'durable') {
      expect(capEvents[0]).toContain('stage=durability');
      expect(capEvents[0]?.join('\t')).toContain(`injected ${kind}`);
    }
  });

  it('turns a writeAtomic throw into a bounded failure and audits the cause', async () => {
    const writeAtomic = vi.fn<WriteAtomic>(async () => {
      throw new Error('injected disk full');
    });
    const { audit, events } = makeAudit();
    const limit = bounds();

    const result = await enforceToolResultBounds(
      context(writeAtomic, audit), 'write-throw', { success: true, content: 'q'.repeat(2_000) }, limit,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('tool_output_artifact_persist_failed');
    expect(result.metadata?.output?.artifact).toEqual({ kind: 'failed' });
    expect(result.content).toContain('artifact=failed');
    expect(result.content).not.toContain('full output saved at');
    expectWithin(result.content, limit);
    const capEvent = events.find(([type]) => type === 'tool_output_cap');
    expect(capEvent).toContain('stage=write');
    expect(capEvent?.join('\t')).toContain('injected disk full');
  });

  it('returns a fixed failure for an over-budget long path and audits the complete path', async () => {
    const artifactKind = 'x'.repeat(300);
    const writeAtomic = vi.fn<WriteAtomic>(durable);
    const { audit, events } = makeAudit();
    const limit = bounds(256, 4, artifactKind);

    const result = await enforceToolResultBounds(
      context(writeAtomic, audit), 'long-path', { success: true, content: 'p'.repeat(2_000) }, limit,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('tool_output_footer_exceeds_bounds');
    expect(result.content).not.toContain(artifactKind);
    expect(result.content).toContain('see audit log for the complete path');
    expectWithin(result.content, limit);
    expect(result.metadata?.output?.artifact).toMatchObject({ kind: 'durable' });
    const budgetEvent = events.find((event) => event[0] === 'tool_output_cap' && event.includes('stage=output-budget'));
    expect(budgetEvent?.join('\t')).toContain(`path=../tasks/sync/${artifactKind}/`);
  });
});

describe('Tool output ownership and parallel execution', () => {
  it('uses toolOutput for both the baseDir-relative write and workspace-relative display', async () => {
    const readSideWrite = vi.fn<WriteAtomic>(durable);
    const outputWrite = vi.fn<WriteAtomic>(durable);
    const ctx = context(readSideWrite);
    ctx.toolOutput = {
      fs: { writeAtomic: outputWrite },
      baseDir: '/owner',
      syncDir: '/owner/tasks/sync',
      workspaceDir: '/owner/clawspace',
    };

    const result = await enforceToolResultBounds(
      ctx, 'tool-output', { success: true, content: 'o'.repeat(2_000) }, bounds(),
    );

    expect(readSideWrite).not.toHaveBeenCalled();
    expect(outputWrite).toHaveBeenCalledOnce();
    const writePath = outputWrite.mock.calls[0]![0];
    expect(nodePath.isAbsolute(writePath)).toBe(false);
    expect(writePath).toMatch(/^tasks\/sync\/test\//);
    const displayPath = nodePath.relative(
      '/owner/clawspace', nodePath.join('/owner/tasks/sync', 'test', nodePath.basename(writePath)),
    );
    expect(result.content).toContain(`full output saved at ${displayPath};`);
    expect(result.metadata?.output?.artifact).toMatchObject({ path: displayPath });
  });

  it('accepts an in-bounds owner-bounded result without a second save', async () => {
    const writeAtomic = vi.fn<WriteAtomic>(durable);
    const raw: ToolResult = {
      success: true,
      content: 'owner preview',
      metadata: {
        output: {
          ownerBounded: true,
          artifact: { kind: 'committed_platform_limited', path: '../tasks/sync/read/existing.md' },
        },
      },
    };

    const result = await enforceToolResultBounds(context(writeAtomic), 'owner', raw, bounds());

    expect(result).toBe(raw);
    expect(writeAtomic).not.toHaveBeenCalled();
  });

  it('fails an over-limit owner-bounded result explicitly without saving its preview', async () => {
    const writeAtomic = vi.fn<WriteAtomic>(durable);
    const raw: ToolResult = {
      success: true,
      content: 'owner preview '.repeat(100),
      metadata: {
        output: {
          ownerBounded: true,
          artifact: { kind: 'durable', path: '../tasks/sync/search/existing.md' },
        },
      },
    };
    const limit = bounds(256, 4);

    const result = await enforceToolResultBounds(context(writeAtomic), 'owner', raw, limit);

    expect(result.success).toBe(false);
    expect(result.error).toBe('owner_bounded_output_exceeds_bounds');
    expect(result.content).toContain('refusing to persist a preview as complete output');
    expectWithin(result.content, limit);
    expect(result.metadata?.output?.artifact).toEqual(raw.metadata?.output?.artifact);
    expect(writeAtomic).not.toHaveBeenCalled();
  });

  it('applies independent caps and unique artifacts during executeParallel', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const writeAtomic = vi.fn<WriteAtomic>(async (path, content) => {
      writes.push({ path, content });
      return durable();
    });
    const registry = new ToolRegistryImpl();
    registry.register(tool('parallel-a', 'a'.repeat(2_000), bounds()));
    registry.register(tool('parallel-b', 'b'.repeat(2_000), bounds()));

    const results = await new ToolExecutorImpl(registry).executeParallel([
      { toolName: 'parallel-a', args: {} },
      { toolName: 'parallel-b', args: {} },
    ], context(writeAtomic));

    expect(results).toHaveLength(2);
    expect(results.every((result) => result?.success === true)).toBe(true);
    expect(writes.map((write) => write.content).sort()).toEqual(['a'.repeat(2_000), 'b'.repeat(2_000)]);
    expect(new Set(writes.map((write) => write.path)).size).toBe(2);
    for (const result of results) expectWithin(result!.content, bounds());
  });

  it('keeps finite centralized defaults', () => {
    expect(Number.isSafeInteger(DEFAULT_TOOL_OUTPUT_BOUNDS.maxBytes)).toBe(true);
    expect(Number.isSafeInteger(DEFAULT_TOOL_OUTPUT_BOUNDS.maxLines)).toBe(true);
    expect(DEFAULT_TOOL_OUTPUT_BOUNDS.maxBytes).toBeGreaterThan(0);
    expect(DEFAULT_TOOL_OUTPUT_BOUNDS.maxLines).toBeGreaterThan(0);
    expect(DEFAULT_TOOL_OUTPUT_BOUNDS.artifactKind).toBe('tool');
  });
});
