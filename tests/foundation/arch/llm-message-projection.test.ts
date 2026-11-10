/** Phase 1800/2076: wire/canonical 分层及生产 buildPiAiContext 投影 ratchet。 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import { buildPiAiContext } from '../../../src/foundation/llm-provider/pi-ai-wire.js';
import { loadPiAiRuntime, resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-support.js';

const TYPES_SRC = readFileSync(new URL('../../../src/foundation/llm-provider/types.ts', import.meta.url), 'utf8');
const CANONICAL_SRC = readFileSync(new URL('../../../src/foundation/dialog-store/canonical-message.ts', import.meta.url), 'utf8');

const METADATA_KEYS = ['origin', 'systemSubtype', 'addedAt', 'trimmed'];
const TOOL_INPUT = {
  query: 'business-query',
  origin: 'business-origin',
  systemSubtype: 'business-system-subtype',
  addedAt: 'business-added-at',
  trimmed: { trimmedAt: 'business-trimmed-at', originalContentBytes: 7 },
};

function projectionConfig(): ProviderConfig {
  return {
    name: 'projection-test',
    apiFormat: 'openai',
    model: 'test-model',
    baseUrl: 'https://api.test.invalid/v1',
    apiKey: 'synthetic-key',
    temperature: 0, timeoutMs: 60_000,
  };
}

function withMetadata(message: Message, marker: string): Message {
  return {
    ...message,
    origin: 'system',
    systemSubtype: `PHASE2076_META_SUBTYPE_${marker}`,
    addedAt: `PHASE2076_META_ADDED_${marker}`,
    trimmed: { trimmedAt: `PHASE2076_META_TRIMMED_${marker}`, originalContentBytes: 1 },
  };
}

function projectionMessages(): Message[] {
  return [
    withMetadata({ role: 'system', content: 'SYSTEM_TEXT' }, 'system'),
    withMetadata({ role: 'user', content: 'USER_STRING' }, 'user-string'),
    withMetadata({ role: 'user', content: [{ type: 'text', text: 'USER_BLOCK' }] }, 'user-block'),
    withMetadata({
      role: 'assistant',
      content: [
        { type: 'text', text: 'ASSISTANT_TEXT' },
        { type: 'thinking', thinking: 'THINKING_TEXT', signature: 'thinking-signature' },
        { type: 'tool_use', id: 'call_projection', name: 'projection_tool', input: TOOL_INPUT },
      ],
    }, 'assistant'),
    withMetadata({
      role: 'user',
      content: [
        { type: 'text', text: 'MIXED_USER_TEXT' },
        {
          type: 'tool_result',
          tool_use_id: 'call_projection',
          content: 'TOOL_RESULT_TEXT',
          is_error: true,
        },
      ],
    }, 'user-mixed'),
  ];
}

describe('llm message projection (phase 1800)', () => {
  it('llm-provider/types.ts 不再声明 Message；ProviderWireMessage 仅 role+content', () => {
    expect(TYPES_SRC).not.toMatch(/export\s+interface\s+Message\s*\{/);
    const m = TYPES_SRC.match(/export\s+interface\s+ProviderWireMessage\s*\{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    const body = m![1].replace(/\/\/[^\n]*/g, '');
    for (const meta of ['origin', 'systemSubtype', 'addedAt', 'trimmed']) expect(body).not.toContain(meta);
  });

  it('canonical Message 唯一声明点 = dialog-store/canonical-message.ts（4 元数据字段）', () => {
    const m = CANONICAL_SRC.match(/export\s+interface\s+Message\s+extends\s+ProviderWireMessage\s*\{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    for (const meta of ['origin?:', 'systemSubtype?:', 'addedAt?:', 'trimmed?:']) expect(m![1]).toContain(meta);
  });

  it('生产 buildPiAiContext 剥离顶层元数据并保留完整角色内容与工具业务键', async () => {
    const config = projectionConfig();
    const messages = projectionMessages();
    const before = structuredClone(messages);
    const runtime = await loadPiAiRuntime();
    const { model } = resolvePiAiModel(runtime, config);

    const context = buildPiAiContext(config, { system: 'OPTIONS_SYSTEM', messages }, model);

    expect(context.systemPrompt).toBe('OPTIONS_SYSTEM\n\nSYSTEM_TEXT');
    expect(context.messages).toHaveLength(5);
    for (const message of context.messages) {
      for (const key of METADATA_KEYS) expect(message).not.toHaveProperty(key);
    }
    expect(JSON.stringify(context)).not.toContain('PHASE2076_META_');
    expect(context.messages[0]).toMatchObject({ role: 'user', content: 'USER_STRING' });
    expect(context.messages[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'USER_BLOCK' }] });
    expect(context.messages[2]).toMatchObject({
      role: 'assistant',
      api: 'openai-completions',
      provider: 'projection-test',
      model: 'test-model',
      timestamp: expect.any(Number),
      usage: expect.any(Object),
    });
    expect(context.messages[2].content).toEqual([
      { type: 'text', text: 'ASSISTANT_TEXT' },
      { type: 'thinking', thinking: 'THINKING_TEXT', thinkingSignature: 'thinking-signature' },
      { type: 'toolCall', id: 'call_projection', name: 'projection_tool', arguments: TOOL_INPUT },
    ]);
    expect(context.messages[3]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'MIXED_USER_TEXT' }] });
    expect(context.messages[4]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_projection',
      toolName: 'projection_tool',
      content: [{ type: 'text', text: 'TOOL_RESULT_TEXT' }],
      isError: true,
    });
    expect(messages).toEqual(before);
  });

  it('生产 buildPiAiContext 的 dropThinkingBlocks 只移除 thinking 块且不改输入', async () => {
    const config = { ...projectionConfig(), dropThinkingBlocks: true };
    const messages = projectionMessages();
    const before = structuredClone(messages);
    const runtime = await loadPiAiRuntime();
    const { model } = resolvePiAiModel(runtime, config);

    const context = buildPiAiContext(config, { system: 'OPTIONS_SYSTEM', messages }, model);

    expect(context.systemPrompt).toBe('OPTIONS_SYSTEM\n\nSYSTEM_TEXT');
    expect(context.messages.map((message) => message.role)).toEqual([
      'user', 'user', 'assistant', 'user', 'toolResult',
    ]);
    expect(context.messages[2].content).toEqual([
      { type: 'text', text: 'ASSISTANT_TEXT' },
      { type: 'toolCall', id: 'call_projection', name: 'projection_tool', arguments: TOOL_INPUT },
    ]);
    expect(context.messages[4]).toMatchObject({
      role: 'toolResult', toolCallId: 'call_projection', isError: true,
    });
    expect(messages).toEqual(before);
  });
});
