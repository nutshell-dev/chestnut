import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatMessages } from '../../../src/foundation/llm-provider/openai-message-formatter.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';
// 不 import provider、不 mock provider、不 mock fs

describe('openai-message-formatter tool_use_id guard (phase 1203 Issue 1)', () => {
  let auditWrites: unknown[][];
  let mockAudit: { write: (type: string, ...cols: unknown[]) => void };

  beforeEach(() => {
    auditWrites = [];
    mockAudit = { write: (type, ...cols) => auditWrites.push([type, ...cols]) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('反向 1: tool_use_id 空串 → skip + TOOL_RESULT_MISSING_ID audit', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: '', content: 'r' }] },
    ];
    const result = formatMessages(messages, undefined, mockAudit);
    expect(result.filter(m => m.role === 'tool')).toHaveLength(0);
    expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_MISSING_ID);
  });

  it('反向 2: tool_use_id undefined → skip + TOOL_RESULT_MISSING_ID audit', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: undefined, content: 'r' }],
      },
    ];
    const result = formatMessages(messages, undefined, mockAudit);
    expect(result.filter(m => m.role === 'tool')).toHaveLength(0);
    expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_MISSING_ID);
  });

  it('反向 3: tool_use_id 有值但 prior assistant.tool_calls 无匹配 id → skip + TOOL_RESULT_ORPHAN_ID', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'tu_orphan', content: 'r' }],
      },
    ];
    const result = formatMessages(messages, undefined, mockAudit);
    expect(result.filter(m => m.role === 'tool')).toHaveLength(0);
    expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_ORPHAN_ID);
    expect(auditWrites[0]).toContainEqual(`tool_use_id=tu_orphan`);
  });

  it('反向 4: tool_use_id 有值且 prior 有匹配 → 正常 emit (happy path regression guard)', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'ok' },
          { type: 'tool_use' as const, id: 'tu_1', name: 'test_tool', input: {} },
        ],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'result_ok' }],
      },
    ];
    const result = formatMessages(messages, undefined, mockAudit);
    const toolMessages = result.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      role: 'tool',
      content: 'result_ok',
      tool_call_id: 'tu_1',
    });
    expect(auditWrites).toHaveLength(0);
  });

  it('反向 5: 混合 — 有效 id emit + 空 id skip + 孤儿 id skip', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use' as const, id: 'tu_valid', name: 'test_tool', input: {} },
        ],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'tu_valid', content: 'r1' },
          { type: 'tool_result' as const, tool_use_id: '', content: 'r2' },
          { type: 'tool_result' as const, tool_use_id: 'tu_orphan', content: 'r3' },
        ],
      },
    ];
    const result = formatMessages(messages, undefined, mockAudit);
    const toolMessages = result.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      role: 'tool',
      content: 'r1',
      tool_call_id: 'tu_valid',
    });
    expect(auditWrites).toHaveLength(2);
    expect(auditWrites.some(w => w[0] === LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_MISSING_ID)).toBe(true);
    expect(auditWrites.some(w => w[0] === LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_ORPHAN_ID)).toBe(true);
  });

  it('反向 6: 不传 auditLog 时 skip 行为不变、不 throw', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: '', content: 'r' }] },
    ];
    expect(() => formatMessages(messages)).not.toThrow();
    const result = formatMessages(messages);
    expect(result.filter(m => m.role === 'tool')).toHaveLength(0);
  });
});
