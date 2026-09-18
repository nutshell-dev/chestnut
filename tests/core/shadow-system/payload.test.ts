/**
 * ShadowExecutorPayload contract tests (phase 1865 SH-D1)
 *
 * Coverage:
 * - buildShadowPayload 1:1 字段映射（systemPrompt/toolsForLLM/budget/postProcessor 透传）
 * - identity 构造（默认/自定义 shadowIdPrefix、originClawId 回退）
 * - messages = synthesizeFormB 产物（instruction 含 SHADOW INSTRUCTION prefix + task）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildShadowPayload, createShadowIdentity } from '../../../src/core/shadow-system/payload.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { SHADOW_INSTRUCTION_PREFIX } from '../../../src/templates/prompts/shadow.js';

describe('buildShadowPayload (phase 1865 SH-D1)', () => {
  let tempDir: string;
  let ctx: ExecContextImpl;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    const fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      fs,
      auditWriter: audit.audit,
      currentToolUseId: 'tu-1',
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  const toolsForLLM: ToolDefinition[] = [
    { type: 'function', function: { name: 'read', description: 'read' } },
  ];

  it('maps fields 1:1 (systemPrompt/toolsForLLM/budget/postProcessor)', () => {
    const payload = buildShadowPayload({
      task: 'do X',
      mainMessages: [{ role: 'user', content: 'prior' }],
      ctx,
      systemPrompt: 'sp',
      toolsForLLM,
      timeoutMs: 1234,
      maxSteps: 7,
      idleTimeoutMs: 99,
      postProcessor: 'summon-contract-extract',
    });

    expect(payload.systemPrompt).toBe('sp');
    expect(payload.toolsForLLM).toBe(toolsForLLM);
    expect(payload.budget).toEqual({ timeoutMs: 1234, maxSteps: 7, idleTimeoutMs: 99 });
    expect(payload.postProcessor).toBe('summon-contract-extract');
  });

  it('keeps budget fields undefined when not passed (fallback 裁决不在构造器)', () => {
    const payload = buildShadowPayload({
      task: 't',
      mainMessages: [],
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
    });

    expect(payload.budget).toEqual({ timeoutMs: undefined, maxSteps: undefined, idleTimeoutMs: undefined });
    expect(payload.postProcessor).toBeUndefined();
  });

  it('identity: default shadowIdPrefix=shadow / custom prefix', () => {
    const dflt = buildShadowPayload({ task: 't', mainMessages: [], ctx, systemPrompt: 'sp', toolsForLLM: [] });
    expect(dflt.identity.shadowId).toMatch(/^shadow-/);

    const summon = buildShadowPayload({
      task: 't',
      mainMessages: [],
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
      shadowIdPrefix: 'summon',
    });
    expect(summon.identity.shadowId).toMatch(/^summon-/);
  });

  it('identity: isShadow 事实由单源携带（phase 1865 SH-D3）', () => {
    const payload = buildShadowPayload({ task: 't', mainMessages: [], ctx, systemPrompt: 'sp', toolsForLLM: [] });
    expect(payload.identity.isShadow).toBe(true);

    expect(createShadowIdentity({ originClawId: 'o1' })).toEqual({
      shadowId: expect.stringMatching(/^shadow-/),
      originClawId: 'o1',
      isShadow: true,
    });
  });

  it('identity.originClawId: explicit opts wins, else falls back to ctx.clawId', () => {
    const fallback = buildShadowPayload({ task: 't', mainMessages: [], ctx, systemPrompt: 'sp', toolsForLLM: [] });
    expect(fallback.identity.originClawId).toBe('test-claw');

    const explicit = buildShadowPayload({
      task: 't',
      mainMessages: [],
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
      originClawId: 'origin-claw',
    });
    expect(explicit.identity.originClawId).toBe('origin-claw');
  });

  it('messages = synthesizeFormB product（main prefix 保留 + instruction 尾条）', () => {
    const mainMessages: Message[] = [
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
    ];
    const payload = buildShadowPayload({
      task: 'unique-task-body-42',
      mainMessages,
      ctx,
      systemPrompt: 'sp',
      toolsForLLM: [],
    });

    expect(payload.messages).toHaveLength(mainMessages.length + 1);
    expect(payload.messages.slice(0, -1)).toEqual(mainMessages);
    const last = payload.messages[payload.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain(SHADOW_INSTRUCTION_PREFIX);
    expect(last.content).toContain('unique-task-body-42');
    expect(last.content).toContain(`shadow_id: ${payload.identity.shadowId}`);
  });
});
