/**
 * Phase 1968 Step C：provider 调用路径审计（LLM-CALL-SUCCESS-PROVENANCE-NOT-AUDITABLE）。
 *
 * 纪律：
 * - 断言一律从磁盘 audit.tsv（生产 AuditWriter → 生产 AuditReader）重建，
 *   不以内存事件回调替代持久化事实；
 * - 审计写失败用注入式 writer error（throw / pending_fallback outcome），不填真实磁盘；
 * - attempt 顺序以实际执行为准（attempt_index 单调），不从配置数组推断；
 * - 审计记录不得包含明文 API key（全文件字节级断言）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fsNative } from 'node:fs';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createAuditWriter } from '../../../src/foundation/audit/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createAuditReader } from '../../../src/foundation/audit/reader.js';
import type { AuditRecord } from '../../../src/foundation/audit/reader.js';
import { createLLMEventSink } from '../../../src/assembly/llm-event-sink.js';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { createRecoverySession } from '../../../src/foundation/llm-orchestrator/recovery.js';
import { LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMAuthError, LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import { LLM_RECOVERY_STATE_FILE } from '../../../src/foundation/llm-orchestrator/recovery-state.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';
import type { ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import type { StreamEvent, StreamLog } from '../../../src/foundation/stream/index.js';

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

const CALL = { messages: [{ role: 'user' as const, content: 'hi' }] };

function okProvider(name: string): ProviderAdapter {
  return {
    name,
    model: 'model-x',
    call: async () => OK_RESPONSE,
    stream: async function* () { throw new Error('stream not enabled in this test'); },
  };
}

function failProvider(name: string, error: Error): ProviderAdapter {
  return {
    name,
    model: 'model-x',
    call: async () => { throw error; },
    stream: async function* () { throw new Error('stream not enabled in this test'); },
  };
}

// ---------------------------------------------------------------------------
// 磁盘审计 harness：生产 writer → 生产 reader（不从内存回调断言）
// ---------------------------------------------------------------------------

async function readAuditRows(dir: string): Promise<AuditRecord[]> {
  const nfs = new NodeFileSystem({ baseDir: dir });
  const reader = createAuditReader(nfs, 'audit.tsv');
  const rows: AuditRecord[] = [];
  try {
    for await (const rec of reader.read()) {
      rows.push(rec);
    }
  } finally {
    reader.close();
  }
  return rows;
}

function colMap(row: AuditRecord): Record<string, string> {
  const m: Record<string, string> = {};
  for (const c of row.cols) {
    const i = c.indexOf('=');
    if (i > 0) m[c.slice(0, i)] = c.slice(i + 1);
  }
  return m;
}

/** 按 invocation 关联键过滤（同一调用的全部路径事实）。 */
function invocationRows(rows: AuditRecord[], invocationId: string): AuditRecord[] {
  return rows.filter(r => r.cols.includes(`invocation=${invocationId}`));
}

function attemptRows(rows: AuditRecord[], invocationId: string) {
  return invocationRows(rows, invocationId)
    .filter(r => r.type === 'llm_call_attempt_result')
    .map(r => colMap(r));
}

function selectionRows(rows: AuditRecord[], invocationId: string) {
  return invocationRows(rows, invocationId)
    .filter(r => r.type === 'llm_call_selection')
    .map(r => colMap(r));
}

/** 最近一次 invocation 的关联键（started 事件顺序即调用顺序）。 */
function lastInvocationId(rows: AuditRecord[]): string {
  const started = rows.filter(r => r.type === 'llm_call_invocation_started');
  expect(started.length).toBeGreaterThan(0);
  return colMap(started[started.length - 1]).invocation;
}

interface HarnessOpts {
  providers: Record<string, ProviderAdapter>;
  primaryName: string;
  fallbackNames?: string[];
  /** 同 endpoint 不同 label 等场景显式给定 baseUrl。 */
  baseUrl?: Record<string, string>;
  apiKey?: Record<string, string>;
  /** 注入式审计写失败（ENOSPC/IO），缺省用生产 writer 落盘。 */
  audit?: AuditLog;
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number };
}

interface Harness {
  service: LLMOrchestratorImpl;
  streamEvents: StreamEvent[];
  readRows: () => Promise<AuditRecord[]>;
}

function makeHarness(dir: string, opts: HarnessOpts): Harness {
  const nfs = new NodeFileSystem({ baseDir: dir });
  const audit = opts.audit ?? createAuditWriter(nfs, 'audit.tsv');
  const streamEvents: StreamEvent[] = [];
  const stream: StreamLog = { write: (e) => { streamEvents.push(e); } };
  const sink = createLLMEventSink(audit, stream);
  const findAdapter = (cfg: ProviderConfig) => {
    const adapter = opts.providers[cfg.name ?? ''];
    if (!adapter) throw new Error(`no mock adapter for ${cfg.name}`);
    return adapter;
  };
  const providerConfig = (name: string): ProviderConfig => ({
    name,
    apiKey: opts.apiKey?.[name] ?? 'test-key',
    model: 'model-x',
    apiFormat: 'anthropic' as const,
    ...(opts.baseUrl?.[name] ? { baseUrl: opts.baseUrl[name] } : {}),
  });
  const service = new LLMOrchestratorImpl({
    primary: providerConfig(opts.primaryName),
    fallbacks: (opts.fallbackNames ?? []).map(providerConfig),
    maxAttempts: 1,
    retryDelayMs: 1,
    events: sink,
    ...(opts.circuitBreaker ? { circuitBreaker: opts.circuitBreaker } : {}),
    createProviderAdapter: findAdapter,
  });
  return {
    service,
    streamEvents,
    readRows: () => readAuditRows(dir),
  };
}

const cleanupDirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await createTrackedTempDir('provider-call-audit-');
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    try { await cleanupTempDir(dir); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------

describe('provider 调用路径审计（磁盘重建）', () => {
  it('primary 成功：started/attempt/selection 关联同一 invocation，最终 provider 明确', async () => {
    const dir = await makeDir();
    const h = makeHarness(dir, {
      providers: { 'kimi-year': okProvider('kimi-year'), 'kimi-year2': okProvider('kimi-year2') },
      primaryName: 'kimi-year',
      fallbackNames: ['kimi-year2'],
      apiKey: { 'kimi-year': 'SECRET-KEY-A', 'kimi-year2': 'SECRET-KEY-B' },
    });

    await h.service.call(CALL);

    const rows = await h.readRows();
    const inv = lastInvocationId(rows);
    const started = invocationRows(rows, inv).find(r => r.type === 'llm_call_invocation_started');
    expect(started).toBeDefined();
    const startedCols = colMap(started!);
    expect(startedCols.kind).toBe('call');
    expect(startedCols.config_rev).toBe('0');
    // 候选清单同时携带 label 与不可逆身份指纹
    expect(startedCols.candidates).toContain('kimi-year:');
    expect(startedCols.candidates).toContain('kimi-year2:');

    expect(attemptRows(rows, inv)).toEqual([
      expect.objectContaining({
        attempt_index: '0', provider: 'kimi-year', outcome: 'success',
      }),
    ]);
    expect(selectionRows(rows, inv)).toEqual([
      expect.objectContaining({
        outcome: 'selected', provider: 'kimi-year', attempt_index: '0',
      }),
    ]);
    // selection 的 provider_id 与 started 候选清单中的身份一致
    const selected = selectionRows(rows, inv)[0];
    expect(startedCols.candidates).toContain(`kimi-year:${selected.provider_id}`);

    // 审计记录不含明文 API key（字节级）
    const raw = await fsNative.readFile(path.join(dir, 'audit.tsv'), 'utf-8');
    expect(raw).not.toContain('SECRET-KEY-A');
    expect(raw).not.toContain('SECRET-KEY-B');
  });

  it('primary 权限失败 + fallback 成功：实际尝试顺序与最终命中可直接读取', async () => {
    const dir = await makeDir();
    const h = makeHarness(dir, {
      providers: {
        'kimi-year': failProvider('kimi-year', new LLMAuthError('kimi-year', 401, 'invalid api key')),
        'kimi-year2': okProvider('kimi-year2'),
      },
      primaryName: 'kimi-year',
      fallbackNames: ['kimi-year2'],
    });

    await h.service.call(CALL);

    const rows = await h.readRows();
    const inv = lastInvocationId(rows);
    expect(attemptRows(rows, inv)).toEqual([
      expect.objectContaining({
        attempt_index: '0', provider: 'kimi-year', outcome: 'failure', error_class: 'permanent',
      }),
      expect.objectContaining({
        attempt_index: '1', provider: 'kimi-year2', outcome: 'success',
      }),
    ]);
    expect(selectionRows(rows, inv)).toEqual([
      expect.objectContaining({ outcome: 'selected', provider: 'kimi-year2', attempt_index: '1' }),
    ]);
  });

  it('fallback1 被熔断跳过 + fallback2 成功：跳过原因持久化', async () => {
    const dir = await makeDir();
    const h = makeHarness(dir, {
      providers: {
        'kimi-year': failProvider('kimi-year', new LLMAuthError('kimi-year', 401)),
        fb1: okProvider('fb1'),
        fb2: okProvider('fb2'),
      },
      primaryName: 'kimi-year',
      fallbackNames: ['fb1', 'fb2'],
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
    });
    // fb1 熔断（index 1 = 第一个 fallback）
    (h.service as unknown as { breakers: { onFailure(c: string): void }[] })
      .breakers[1].onFailure('transient');

    await h.service.call(CALL);

    const rows = await h.readRows();
    const inv = lastInvocationId(rows);
    expect(attemptRows(rows, inv)).toEqual([
      expect.objectContaining({ attempt_index: '0', provider: 'kimi-year', outcome: 'failure', error_class: 'permanent' }),
      expect.objectContaining({ attempt_index: '1', provider: 'fb1', outcome: 'skipped', reason: 'circuit_breaker_open' }),
      expect.objectContaining({ attempt_index: '2', provider: 'fb2', outcome: 'success' }),
    ]);
    expect(selectionRows(rows, inv)).toEqual([
      expect.objectContaining({ outcome: 'selected', provider: 'fb2', attempt_index: '2' }),
    ]);
  });

  it('所有 provider 失败：每个候选各有终态，聚合错误与审计逐项对应', async () => {
    const dir = await makeDir();
    const h = makeHarness(dir, {
      providers: {
        'kimi-year': failProvider('kimi-year', new LLMAuthError('kimi-year', 401)),
        fb1: failProvider('fb1', new LLMNetworkError('fb1', new Error('ECONNREFUSED'))),
        fb2: failProvider('fb2', new LLMAuthError('fb2', 403)),
      },
      primaryName: 'kimi-year',
      fallbackNames: ['fb1', 'fb2'],
    });

    const err = await h.service.call(CALL).catch(e => e);
    expect(err).toBeInstanceOf(LLMAllProvidersFailedError);

    const rows = await h.readRows();
    const inv = lastInvocationId(rows);
    const attempts = attemptRows(rows, inv);
    expect(attempts).toEqual([
      expect.objectContaining({ attempt_index: '0', provider: 'kimi-year', outcome: 'failure', error_class: 'permanent' }),
      expect.objectContaining({ attempt_index: '1', provider: 'fb1', outcome: 'failure', error_class: 'transient' }),
      expect.objectContaining({ attempt_index: '2', provider: 'fb2', outcome: 'failure', error_class: 'permanent' }),
    ]);
    expect(selectionRows(rows, inv)).toEqual([
      expect.objectContaining({ outcome: 'exhausted' }),
    ]);

    // 聚合错误与审计逐 provider 对应（身份指纹 + 执行序）
    const failures = (err as LLMAllProvidersFailedError).failures;
    expect(failures.map(f => f.provider)).toEqual(['kimi-year', 'fb1', 'fb2']);
    for (let i = 0; i < failures.length; i++) {
      expect(failures[i].attemptIndex).toBe(i);
      expect(attempts[i].provider_id).toBe(failures[i].providerId);
    }
  });

  it('同 endpoint 不同 label：technical identity、label、config revision 关系可重建', async () => {
    const dir = await makeDir();
    // kimi-year / kimi-year2：同 endpoint、同 model、同 key，仅显示名不同
    const h = makeHarness(dir, {
      providers: {
        'kimi-year': failProvider('kimi-year', new LLMAuthError('kimi-year', 401)),
        'kimi-year2': okProvider('kimi-year2'),
      },
      primaryName: 'kimi-year',
      fallbackNames: ['kimi-year2'],
      baseUrl: { 'kimi-year': 'https://api.example.com', 'kimi-year2': 'https://api.example.com' },
      apiKey: { 'kimi-year': 'SHARED-KEY', 'kimi-year2': 'SHARED-KEY' },
    });

    await h.service.call(CALL);
    await h.service.call(CALL); // 第二次调用：身份稳定、config_rev 稳定

    const rows = await h.readRows();
    const started = rows.filter(r => r.type === 'llm_call_invocation_started');
    expect(started).toHaveLength(2);
    const c1 = colMap(started[0]);
    const c2 = colMap(started[1]);
    // 同配置代次 → 候选身份指纹逐字稳定（身份不随调用漂移）
    expect(c1.candidates).toBe(c2.candidates);
    expect(c1.config_rev).toBe('0');
    expect(c2.config_rev).toBe('0');
    // 同 endpoint 不同 label → 不同 technical identity，且 label 直接可读
    const parts = c1.candidates.split(',');
    const idYear = parts.find(p => p.startsWith('kimi-year:'))!.slice('kimi-year:'.length);
    const idYear2 = parts.find(p => p.startsWith('kimi-year2:'))!.slice('kimi-year2:'.length);
    expect(idYear).not.toBe(idYear2);
    expect(idYear).not.toBe(`unknown:kimi-year`);
    // 命中的是 kimi-year2（label + identity 双双落盘）
    const inv = colMap(started[0]).invocation;
    expect(selectionRows(rows, inv)).toEqual([
      expect.objectContaining({ outcome: 'selected', provider: 'kimi-year2', provider_id: idYear2 }),
    ]);
  });

  it('成功前进程中断（abort）：重启读取不得伪造已持久化成功', async () => {
    const dir = await makeDir();
    const h = makeHarness(dir, {
      providers: { 'kimi-year': okProvider('kimi-year') },
      primaryName: 'kimi-year',
    });

    // 调用前即 abort：invocation 已开始（started 落盘），无任何候选终态、无 selection——
    // 与「成功返回前进程被杀」同形：磁盘上只有未完成路径。
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(h.service.call({ ...CALL, signal: ctrl.signal })).rejects.toThrow();

    // 「重启」= 新进程视角重新读磁盘（新 reader、同一文件）
    const rows = await h.readRows();
    const inv = lastInvocationId(rows);
    // 无 selection、无 success attempt —— 不存在被伪造的成功事实
    expect(selectionRows(rows, inv)).toEqual([]);
    expect(attemptRows(rows, inv).filter(a => a.outcome === 'success')).toEqual([]);
  });

  it('审计写失败（注入 ENOSPC throw）：调用状态显式暴露审计失败，不静默丢弃', async () => {
    const dir = await makeDir();
    const failingAudit: AuditLog = {
      __brand: 'AuditLog',
      write: () => { throw new Error('ENOSPC: no space left on device'); },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
      artifact: () => [],
      loss: () => [],
    };
    const h = makeHarness(dir, {
      providers: { 'kimi-year': okProvider('kimi-year') },
      primaryName: 'kimi-year',
      audit: failingAudit,
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 调用本身成功（错误隔离），但审计失败必须成为显式事实
    await h.service.call(CALL);
    const sawCritical = consoleSpy.mock.calls.some(args =>
      typeof args[0] === 'string' && args[0].includes('[LLM EVENT SINK CRITICAL]'));
    consoleSpy.mockRestore();
    expect(sawCritical).toBe(true);

    // stream.jsonl 独立通道：原事件 + 每个失败事件的 llm_call_audit_write_failed marker
    const markers = h.streamEvents.filter(e => e.type === 'call_audit_write_failed');
    expect(markers.length).toBeGreaterThan(0);
    const started = h.streamEvents.find(e => e.type === 'call_invocation_started') as { invocationId: string };
    const selection = h.streamEvents.find(e => e.type === 'call_selection') as { invocationId: string };
    expect(selection).toBeDefined();
    // selection 事件的审计失败 marker 携带同一 invocation —— “成功但审计未持久化”显式可关联
    const selectionMarker = markers.find(m => (m as { eventType?: string }).eventType === 'call_selection');
    expect(selectionMarker).toBeDefined();
    expect((selectionMarker as { invocationId?: string }).invocationId).toBe(started.invocationId);
    expect((selectionMarker as { reason?: string }).reason).toContain('ENOSPC');
  });

  it('审计写降级（pending_fallback outcome）：非 durable 落盘显式标记', async () => {
    const dir = await makeDir();
    const degradedAudit: AuditLog = {
      __brand: 'AuditLog',
      write: () => ({
        kind: 'pending_fallback',
        path: '/x/audit.tsv',
        row: 'row',
        error: new Error('ENOSPC: no space left on device'),
      }),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
      artifact: () => [],
      loss: () => [],
    };
    const h = makeHarness(dir, {
      providers: { 'kimi-year': okProvider('kimi-year') },
      primaryName: 'kimi-year',
      audit: degradedAudit,
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await h.service.call(CALL);
    } finally {
      consoleSpy.mockRestore();
    }

    const markers = h.streamEvents.filter(e => e.type === 'call_audit_write_failed');
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      expect((m as { reason?: string }).reason).toContain('pending_fallback');
    }
  });

  it('scoped 恢复失败事实：label/invocation/attemptIndex/configRevision 随状态落盘', async () => {
    const dir = await makeDir();
    const nfs = new NodeFileSystem({ baseDir: dir });
    const emitted: LLMEvent[] = [];
    const sink: LLMEventSink = { emit: (e) => { emitted.push(e); } };
    const adapter = failProvider('kimi-year', new LLMNetworkError('kimi-year', new Error('ECONNREFUSED')));
    const orchestrator = new LLMOrchestratorImpl({
      primary: { name: 'kimi-year', apiKey: 'test-key', model: 'model-x', apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 1,
      events: sink,
      createProviderAdapter: () => adapter,
    });
    const session = createRecoverySession({
      scopeId: 'foreground',
      fs: nfs,
      events: sink,
      orchestrator,
      now: () => Date.now(),
    });
    const admission = await session.begin({ requestKey: 'rk-1', facts: { interventionIds: [] } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');

    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    // 恢复状态磁盘证据：providerLabel + invocationId + attemptIndex + configRevision
    const state = JSON.parse(
      await fsNative.readFile(path.join(dir, 'status', LLM_RECOVERY_STATE_FILE), 'utf-8'),
    );
    expect(state.failures).toHaveLength(1);
    const ev = state.failures[0];
    expect(ev.providerLabel).toBe('kimi-year');
    expect(typeof ev.invocationId).toBe('string');
    expect(ev.attemptIndex).toBe(0);
    expect(ev.configRevision).toBe(0);
    // provider fact 同步携带 label（身份↔名称关系可见）
    expect(state.providers[0].providerLabel).toBe('kimi-year');
    // invocationId 与审计事件的 invocation 关联键同源
    const started = emitted.find(e => e.type === 'call_invocation_started') as { invocationId: string };
    expect(ev.invocationId).toBe(started.invocationId);
  });
});
