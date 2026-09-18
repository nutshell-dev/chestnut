/**
 * phase 1858 Step H (SA-D7): typed capture 显示协议与边界验证。
 *
 * 根因：getDisplayResult 把 unknown 强转 `{ result?: string }` —— 畸形/异构协议被
 * 静默折叠成 text（`?? text` 兜底掩盖）。
 *
 * 矩阵：
 * ① parseCapturedResult 协议判定（ok / 非对象 / null / 缺 result / result 非 string）
 * ② getDisplayResult 三态（合协议 → 显示值；无 capture → text；畸形 → text 回退、不折叠）
 * ③ run 边界：自定义 resultTool 返回不合协议值 → 登记 audit（不静默）；合协议 → 零登记
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/agent-executor/loop.js', () => ({
  runReact: vi.fn(),
}));

vi.mock('../../../src/foundation/audit/index.js', () => ({
  createAuditWriter: vi.fn().mockReturnValue({ write: vi.fn(), summary: (s: string) => s, message: (s: string) => s, preview: (s: string) => s }),
  makeTraceId: vi.fn((value: string) => value),
}));

vi.mock('../../../src/foundation/dialog-store/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/foundation/dialog-store/index.js')>()),
  createDialogStore: vi.fn().mockReturnValue({
    save: vi.fn().mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] }),
    load: vi.fn().mockResolvedValue({ source: 'current', session: { messages: [] } }),
  }),
}));

import { runSubagent, getDisplayResult } from '../../../src/core/subagent/run.js';
import { parseCapturedResult } from '../../../src/core/subagent/tools/done.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
import { runReact } from '../../../src/core/agent-executor/loop.js';

const runReactMock = vi.mocked(runReact);

describe('phase 1858 Step H: parseCapturedResult 协议判定（SA-D7）', () => {
  it('合协议 { result: string } → ok（附加字段不干扰）', () => {
    expect(parseCapturedResult({ result: 'hello' })).toEqual({ kind: 'ok', value: { result: 'hello' } });
    expect(parseCapturedResult({ result: 'hi', extra: 1 })).toEqual({ kind: 'ok', value: { result: 'hi' } });
  });

  it('非对象（string/number/boolean）→ malformed', () => {
    expect(parseCapturedResult('plain').kind).toBe('malformed');
    expect(parseCapturedResult(42).kind).toBe('malformed');
    expect(parseCapturedResult(true).kind).toBe('malformed');
  });

  it('null / undefined → malformed', () => {
    expect(parseCapturedResult(null).kind).toBe('malformed');
    expect(parseCapturedResult(undefined).kind).toBe('malformed');
  });

  it('缺 result 字段 → malformed（reason 含字段语义）', () => {
    const parsed = parseCapturedResult({ passed: true });
    expect(parsed.kind).toBe('malformed');
    expect((parsed as { reason: string }).reason).toContain('result field must be string');
  });

  it('result 非 string → malformed（不静默当 string 用）', () => {
    expect(parseCapturedResult({ result: 42 }).kind).toBe('malformed');
    expect(parseCapturedResult({ result: null }).kind).toBe('malformed');
    expect(parseCapturedResult({ result: { nested: true } }).kind).toBe('malformed');
  });
});

describe('phase 1858 Step H: getDisplayResult 三态（SA-D7）', () => {
  it('合协议 → 显示 capturedResult.result', () => {
    expect(getDisplayResult('fallback text', { result: 'structured' })).toBe('structured');
  });

  it('无 capture（undefined）→ text', () => {
    expect(getDisplayResult('fallback text', undefined)).toBe('fallback text');
  });

  it('畸形 capture → text 回退（不折叠、不显示畸形值）', () => {
    expect(getDisplayResult('fallback text', { result: 42 })).toBe('fallback text');
    expect(getDisplayResult('fallback text', { passed: true })).toBe('fallback text');
    expect(getDisplayResult('fallback text', 'plain string')).toBe('fallback text');
    expect(getDisplayResult('fallback text', null)).toBe('fallback text');
  });
});

function makeFs() {
  return {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    appendSync: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(''),
    exists: vi.fn().mockResolvedValue(false),
  } as any;
}

describe('phase 1858 Step H: run 边界登记（SA-D7）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeOptsWithForeignResultTool(foreignCaptured: unknown) {
    const registry = {
      getAll: vi.fn().mockReturnValue([]),
      formatForLLM: vi.fn().mockReturnValue([]),
      has: vi.fn().mockReturnValue(false),
      get: vi.fn((name: string) => (name === 'custom_result' ? { name, capturedResult: foreignCaptured } : undefined)),
    };
    return {
      agentId: 'capture-agent',
      clawDir: '/tmp/test',
      fs: makeFs(),
      llm: {} as any,
      registry: registry as any,
      prompt: 'do something',
      systemPrompt: 'system',
      resultDir: '/tmp/test/result-capture',
      syncDir: '/tmp/test/tasks/sync',
      resultTool: 'custom_result',
    };
  }

  it('自定义 resultTool 返回畸形值 → outcome 原样携带 + audit 登记（不静默）', async () => {
    const { createAuditWriter } = await import('../../../src/foundation/audit/index.js');
    const auditRows: unknown[][] = [];
    (createAuditWriter as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      write: vi.fn((event: string, ...cols: unknown[]) => { auditRows.push([event, ...cols]); }),
      summary: (s: string) => s,
      message: (s: string) => s,
      preview: (s: string) => s,
    });
    runReactMock.mockResolvedValue({ finalText: 'text result', stopReason: 'end_turn' });

    const result = await runSubagent(makeOptsWithForeignResultTool({ result: 42 }) as any);

    // 原值保留在 outcome（不丢弃）、显示层回退 text
    expect(result.capturedResult).toEqual({ result: 42 });
    expect(getDisplayResult(result.text, result.capturedResult)).toBe('text result');

    const malformedRows = auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.CAPTURE_PROTOCOL_MALFORMED);
    expect(malformedRows).toHaveLength(1);
    expect(malformedRows[0]).toContain('tool=custom_result');
    expect(String(malformedRows[0].join(' '))).toContain('result field must be string');
  });

  it('自定义 resultTool 返回合协议值 → 零登记 + 显示层用 capturedResult', async () => {
    const { createAuditWriter } = await import('../../../src/foundation/audit/index.js');
    const auditRows: unknown[][] = [];
    (createAuditWriter as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      write: vi.fn((event: string, ...cols: unknown[]) => { auditRows.push([event, ...cols]); }),
      summary: (s: string) => s,
      message: (s: string) => s,
      preview: (s: string) => s,
    });
    runReactMock.mockResolvedValue({ finalText: 'text result', stopReason: 'end_turn' });

    const result = await runSubagent(makeOptsWithForeignResultTool({ result: 'structured' }) as any);

    expect(result.capturedResult).toEqual({ result: 'structured' });
    expect(getDisplayResult(result.text, result.capturedResult)).toBe('structured');
    expect(auditRows.filter((r) => r[0] === SUBAGENT_AUDIT_EVENTS.CAPTURE_PROTOCOL_MALFORMED)).toHaveLength(0);
  });
});
