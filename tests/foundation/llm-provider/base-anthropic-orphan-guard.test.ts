import { describe, it, expect, vi } from 'vitest';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';

describe('base-anthropic orphan guard (phase 1274)', () => {
  it('反向: 孤儿 tool_result → skip + TOOL_RESULT_ORPHAN_ID audit', () => {
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
        content: [{ type: 'tool_use' as const, id: 'A', name: 'foo', input: {} }],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'A', content: 'ok' }],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'B-orphan', content: 'fake' }],
      },
    ];

    const result = (adapter as any).formatMessages(messages);

    // No B-orphan block in output
    const allToolResults = result.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : []
    );
    expect(allToolResults.some((b: any) => b.tool_use_id === 'B-orphan')).toBe(false);
    expect(allToolResults.some((b: any) => b.tool_use_id === 'A')).toBe(true);

    // Audit hit TOOL_RESULT_ORPHAN_ID once
    expect(auditWrites.filter(w => w[0] === LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_ORPHAN_ID)).toHaveLength(1);
  });
});
