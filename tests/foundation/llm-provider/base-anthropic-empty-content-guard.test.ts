import { describe, it, expect } from 'vitest';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';

describe('base-anthropic empty content guard (phase 1274)', () => {
  it('反向: assistant content [] → skip 整条 + ASSISTANT_EMPTY_CONTENT_SKIPPED audit', () => {
    const auditWrites: unknown[][] = [];
    const mockAudit = { write: (type: string, ...cols: unknown[]) => auditWrites.push([type, ...cols]) };

    const adapter = new CustomAnthropicAdapter({
      name: 'test-provider',
      apiKey: 'test',
      model: 'test-model',
      maxTokens: 1024,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
      auditLog: mockAudit as any,
    });

    const messages = [
      {
        role: 'assistant' as const,
        content: [],
      },
    ];

    const result = (adapter as any).formatMessages(messages);

    expect(result.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
    expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.ASSISTANT_EMPTY_CONTENT_SKIPPED);
  });

  it('反向: dropThinking 后 assistant 只剩 thinking → skip 整条 + ASSISTANT_EMPTY_CONTENT_SKIPPED audit', () => {
    const auditWrites: unknown[][] = [];
    const mockAudit = { write: (type: string, ...cols: unknown[]) => auditWrites.push([type, ...cols]) };

    const adapter = new CustomAnthropicAdapter({
      name: 'test-provider',
      apiKey: 'test',
      model: 'test-model',
      maxTokens: 1024,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
      dropThinkingBlocks: true,
      auditLog: mockAudit as any,
    });

    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'thinking' as const, thinking: '...' }],
      },
    ];

    const result = (adapter as any).formatMessages(messages);

    expect(result.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
    expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.ASSISTANT_EMPTY_CONTENT_SKIPPED);
  });
});
