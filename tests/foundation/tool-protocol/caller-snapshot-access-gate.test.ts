/**
 * phase 1406: Tool caller-snapshot access gate invariants
 *
 * Verifies:
 *   1. CallerSnapshot type lives in tool-protocol (L2b protocol layer)
 *   2. ExecContext.getCallerSnapshot is optional (M#8 minimal)
 *   3. Tool.accessesCaller is optional (default false)
 *   4. Tools without accessesCaller=true that call getCallerSnapshot() throw
 *      + emit 'tool_caller_access_violation' audit
 *   5. Tools with accessesCaller=true but ctx without provider also throw
 *      + emit 'tool_caller_access_violation' audit (reason=provider_not_bound)
 *   6. Tools with accessesCaller=true and ctx with provider succeed
 *   7. Lazy: undeclared tools never invoke the provider (0 cost)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { AuditWriter } from '../../../src/foundation/audit/writer.js';
import type { Tool, ExecContext } from '../../../src/foundation/tools/types.js';
import type { CallerSnapshot } from '../../../src/foundation/tool-protocol/index.js';
import type { ToolResult, JSONSchema7 } from '../../../src/foundation/tool-protocol/index.js';

function makeTool(opts: {
  name: string;
  accessesCaller?: boolean;
  execute: (args: Record<string, unknown>, ctx: ExecContext) => Promise<ToolResult>;
}): Tool {
  return {
    name: opts.name,
    description: 'test tool',
    schema: { type: 'object' } as JSONSchema7,
    readonly: false,
    idempotent: false,
    profiles: ['full'],
    accessesCaller: opts.accessesCaller,
    execute: opts.execute,
  };
}

async function setup(opts: { withProvider: boolean; snapshotData?: CallerSnapshot }) {
  const tempDir = path.join(tmpdir(), `chestnut-test-1406-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  const mockFs = new NodeFileSystem({ baseDir: tempDir });
  const auditEntries: Array<{ type: string; fields: string[] }> = [];
  const audit = {
    write: (type: string, ...fields: string[]) => auditEntries.push({ type, fields }),
    flush: async () => {},
    setTraceId: () => {},
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  } as unknown as AuditWriter;
  const ctx = new ExecContextImpl({
    clawId: 'test-claw',
    clawDir: tempDir,
    clawsDir: path.join(tempDir, 'claws'),
    syncDir: tempDir,
    profile: 'full',
    callerLabel: 'test',
    fs: mockFs,
    maxSteps: 10,
    auditWriter: audit,
    getCallerSnapshot: opts.withProvider
      ? async () => opts.snapshotData ?? { systemPrompt: 's', tools: [], messages: [] }
      : undefined,
  });
  const registry = new ToolRegistryImpl();
  const executor = new ToolExecutorImpl(registry);
  return { ctx, registry, executor, audit, auditEntries, tempDir };
}

describe('phase 1406 caller-snapshot access gate', () => {
  it('undeclared tool calling getCallerSnapshot() throws + emits violation audit', async () => {
    const { ctx, registry, executor, auditEntries } = await setup({ withProvider: true });
    const tool = makeTool({
      name: 'undeclared',
      execute: async (_args, c) => {
        try {
          await c.getCallerSnapshot!();
          return { success: true, content: 'unreachable' };
        } catch (err) {
          return { success: false, content: 'caught', error: (err as Error).message };
        }
      },
    });
    registry.register(tool);

    const result = await executor.execute({ toolName: 'undeclared', args: {}, ctx });

    expect(result.success).toBe(false);
    expect(result.error).toContain('accessesCaller=true');
    const violations = auditEntries.filter((e) => e.type === 'tool_caller_access_violation');
    expect(violations).toHaveLength(1);
    expect(violations[0].fields).toContain('reason=accessesCaller_not_declared');
  });

  it('declared tool without bound provider throws + emits violation (provider_not_bound)', async () => {
    const { ctx, registry, executor, auditEntries } = await setup({ withProvider: false });
    const tool = makeTool({
      name: 'declared-but-unbound',
      accessesCaller: true,
      execute: async (_args, c) => {
        try {
          await c.getCallerSnapshot!();
          return { success: true, content: 'unreachable' };
        } catch (err) {
          return { success: false, content: 'caught', error: (err as Error).message };
        }
      },
    });
    registry.register(tool);

    const result = await executor.execute({ toolName: 'declared-but-unbound', args: {}, ctx });

    expect(result.success).toBe(false);
    expect(result.error).toContain('getCallerSnapshot provider');
    const violations = auditEntries.filter((e) => e.type === 'tool_caller_access_violation');
    expect(violations).toHaveLength(1);
    expect(violations[0].fields).toContain('reason=provider_not_bound');
  });

  it('declared tool with bound provider gets the snapshot', async () => {
    const snap: CallerSnapshot = {
      systemPrompt: 'sys-prompt',
      tools: [{ name: 'foo', description: 'd', input_schema: {} as JSONSchema7 }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const { ctx, registry, executor, auditEntries } = await setup({
      withProvider: true,
      snapshotData: snap,
    });
    const tool = makeTool({
      name: 'declared-and-bound',
      accessesCaller: true,
      execute: async (_args, c) => {
        const got = await c.getCallerSnapshot!();
        return { success: true, content: `${got.systemPrompt}|${got.tools.length}|${got.messages.length}` };
      },
    });
    registry.register(tool);

    const result = await executor.execute({ toolName: 'declared-and-bound', args: {}, ctx });

    expect(result.success).toBe(true);
    expect(result.content).toBe('sys-prompt|1|1');
    const violations = auditEntries.filter((e) => e.type === 'tool_caller_access_violation');
    expect(violations).toHaveLength(0);
  });

  it('lazy: undeclared tool not calling snapshot() incurs 0 audit emit + 0 provider invocations', async () => {
    let providerInvocations = 0;
    const tempDir = path.join(tmpdir(), `chestnut-test-1406-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const mockFs = new NodeFileSystem({ baseDir: tempDir });
    const auditEntries: Array<{ type: string; fields: string[] }> = [];
    const audit = {
      write: (type: string, ...fields: string[]) => auditEntries.push({ type, fields }),
      flush: async () => {},
      setTraceId: () => {},
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    } as unknown as AuditWriter;
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      clawsDir: path.join(tempDir, 'claws'),
      syncDir: tempDir,
      profile: 'full',
      callerLabel: 'test',
      fs: mockFs,
      maxSteps: 10,
      auditWriter: audit,
      getCallerSnapshot: async () => {
        providerInvocations++;
        return { systemPrompt: 's', tools: [], messages: [] };
      },
    });
    const registry = new ToolRegistryImpl();
    const executor = new ToolExecutorImpl(registry);
    const tool = makeTool({
      name: 'noop',
      execute: async () => ({ success: true, content: 'no snapshot call' }),
    });
    registry.register(tool);

    const result = await executor.execute({ toolName: 'noop', args: {}, ctx });

    expect(result.success).toBe(true);
    expect(providerInvocations).toBe(0);
    expect(auditEntries.filter((e) => e.type === 'tool_caller_access_violation')).toHaveLength(0);
  });
});
