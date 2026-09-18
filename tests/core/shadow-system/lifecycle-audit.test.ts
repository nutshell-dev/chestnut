/**
 * shadow lifecycle audit single owner tests (phase 1865 SH-D9)
 *
 * Coverage:
 * - 五场景事件逐列不变（recursion_rejected / started / prefix_restored / failed×2 / finished）
 * - 写入点单源（mechanical：SHADOW_AUDIT_EVENTS / auditWriter.write 仅在 owner 模块）
 * - 省略 sink（无 auditWriter）行为保持
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fsPromises from 'fs/promises';
import { fileURLToPath } from 'url';
import { createShadowTool } from '../../../src/core/shadow-system/index.js';
import { runShadow } from '../../../src/core/shadow-system/system.js';
import { SHADOW_AUDIT_EVENTS } from '../../../src/core/shadow-system/audit-events.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

describe('shadow lifecycle audit (phase 1865 SH-D9)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let baseCtx: ExecContextImpl;

  function makeRegistry(): ToolRegistryImpl {
    const registry = new ToolRegistryImpl();
    registry.register({
      name: 'read',
      description: 'read',
      schema: { type: 'object', properties: {} },
      readonly: true,
      idempotent: true,
      execute: vi.fn(),
    });
    registry.register({
      name: 'done',
      description: 'done',
      schema: { type: 'object', properties: {} },
      readonly: false,
      idempotent: false,
      execute: vi.fn(),
    });
    return registry;
  }

  function makeLLM(): LLMOrchestrator {
    return {
      call: vi.fn(),
      stream: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getProviderInfo: vi.fn().mockReturnValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as LLMOrchestrator;
  }

  const snapshot = () => ({
    systemPrompt: 'sp',
    tools: [] as ToolDefinition[],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'shadow', input: {} }] },
    ] as Message[],
  });

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    baseCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs: nodeFs,
      auditWriter: audit.audit,
      llm: makeLLM(),
      registry: makeRegistry(),
      currentToolUseId: 'tu-1',
    });
    mockRunSubagent.mockReset();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('scenario recursion_rejected — 入口层事件经 owner 写入、列不变', async () => {
    const tool = createShadowTool({ getTurnSnapshot: snapshot, allowRecursion: false });

    await tool.execute({ task: 'recursive' }, baseCtx);

    expect(audit.events).toEqual([[SHADOW_AUDIT_EVENTS.RECURSION_REJECTED, 'test-claw']]);
  });

  it('scenario started + finished — 执行层事件逐列不变', async () => {
    mockRunSubagent.mockResolvedValue({ text: 'ok' });
    const tool = createShadowTool({ getTurnSnapshot: snapshot, runSubagent: mockRunSubagent });

    const result = await tool.execute({ task: 'do X', async: false }, baseCtx);
    expect(result.success).toBe(true);

    const started = audit.events.find(e => e[0] === SHADOW_AUDIT_EVENTS.STARTED)!;
    const finished = audit.events.find(e => e[0] === SHADOW_AUDIT_EVENTS.FINISHED)!;
    expect(started[1]).toMatch(/^shadow-/);
    expect(started[2]).toBe('do X');
    expect(finished).toEqual([SHADOW_AUDIT_EVENTS.FINISHED, `shadowId=${started[1]}`]);
    expect(audit.events.map(e => e[0])).toEqual([
      SHADOW_AUDIT_EVENTS.STARTED,
      SHADOW_AUDIT_EVENTS.PREFIX_RESTORED,
      SHADOW_AUDIT_EVENTS.FINISHED,
    ]);
  });

  it('scenario prefix_restored — marker 查找成功后留痕（raw shadowId + key= prefix）', async () => {
    mockRunSubagent.mockResolvedValue({ text: 'ok' });

    const result = await runShadow({
      task: 'do X',
      ctx: baseCtx,
      runSubagent: mockRunSubagent,
      turnSnapshot: snapshot(),
    });
    expect(result.success).toBe(true);

    const prefixRestored = audit.events.find(e => e[0] === SHADOW_AUDIT_EVENTS.PREFIX_RESTORED);
    expect(prefixRestored).toBeDefined();
    expect(prefixRestored![1]).toMatch(/^shadowId=shadow-/);
  });

  it('scenario failed×2 — 执行失败（无 phase）与早退失败（带 phase）列形态各自不变', async () => {
    mockRunSubagent.mockRejectedValue(new Error('boom'));
    const tool = createShadowTool({ getTurnSnapshot: snapshot, runSubagent: mockRunSubagent });

    await tool.execute({ task: 'fail', async: false }, baseCtx);
    const execFailed = audit.events.filter(e => e[0] === SHADOW_AUDIT_EVENTS.FAILED);
    expect(execFailed).toHaveLength(1);
    expect(execFailed[0][1]).toMatch(/^shadowId=shadow-/);
    expect(execFailed[0][2]).toBe('error=boom');

    // 第二场景：prefix 早退失败（带 phase col）
    audit.events.length = 0;
    await runShadow({
      task: 't',
      ctx: baseCtx,
      runSubagent: mockRunSubagent,
      turnSnapshot: { systemPrompt: 'sp', tools: [], messages: [{ role: 'user', content: 'no marker' }] },
    });
    const earlyFailed = audit.events.filter(e => e[0] === SHADOW_AUDIT_EVENTS.FAILED);
    expect(earlyFailed).toHaveLength(1);
    expect(earlyFailed[0][1]).toMatch(/^shadowId=shadow-/);
    expect(earlyFailed[0][2]).toBe('phase=prefix_restore');
    expect(String(earlyFailed[0][3])).toContain('marker not found');
  });

  it('省略 sink（无 auditWriter）→ 静默、行为保持', async () => {
    mockRunSubagent.mockResolvedValue({ text: 'ok' });
    const ctxNoAudit = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs: nodeFs,
      llm: makeLLM(),
      registry: makeRegistry(),
      currentToolUseId: 'tu-1',
    });
    const tool = createShadowTool({ getTurnSnapshot: snapshot, runSubagent: mockRunSubagent });

    const result = await tool.execute({ task: 't', async: false }, ctxNoAudit);

    expect(result.success).toBe(true);
    expect(audit.events).toEqual([]);
  });

  it('写入点单源（mechanical）：SHADOW_AUDIT_EVENTS / auditWriter.write 仅 owner 模块', async () => {
    const dir = path.resolve(__dirname, '../../../src/core/shadow-system');
    const offenders: string[] = [];

    async function walk(current: string): Promise<void> {
      for (const entry of await fsPromises.readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(dir, full);
        if (rel === 'audit-events.ts' || rel === 'lifecycle-audit.ts') continue;
        const content = await fsPromises.readFile(full, 'utf-8');
        if (content.includes('SHADOW_AUDIT_EVENTS')) offenders.push(`${rel}: SHADOW_AUDIT_EVENTS`);
        if (/auditWriter\??\.write\(/.test(content)) offenders.push(`${rel}: auditWriter.write`);
      }
    }

    await walk(dir);
    expect(offenders).toEqual([]);
  });
});
