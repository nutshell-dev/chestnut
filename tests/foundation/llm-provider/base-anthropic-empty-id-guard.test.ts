import { describe, it, expect } from 'vitest';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';

describe('base-anthropic empty id guard (phase 1274)', () => {
  it('反向: tool_use_id 空串 → skip + TOOL_RESULT_MISSING_ID audit', () => {
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
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: '', content: 'x' }],
      },
    ];

    const result = (adapter as any).formatMessages(messages);

    const allToolResults = result.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : []
    );
    expect(allToolResults).toHaveLength(0);
    expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_MISSING_ID);
  });
});
