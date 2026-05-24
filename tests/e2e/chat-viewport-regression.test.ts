import { describe, it, expect, afterEach } from 'vitest';
import { promises as nativeFs, appendFileSync as nativeAppend } from 'node:fs';
import * as nativePath from 'node:path';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createDirContext } from '../../src/cli/utils/factories.js';
import {
  createStreamReader,
  STREAM_FILE,
  StreamWriter,
  type StreamReader,
  type StreamEvent,
} from '../../src/foundation/stream/index.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/cli/commands/viewport-audit-events.js';
import { STREAM_AUDIT_EVENTS } from '../../src/foundation/stream/audit-events.js';
import { AUDIT_FILE } from '../../src/foundation/audit/index.js';
import {
  createMainTurnUI,
  type MainTurnUIController,
} from '../../src/cli/commands/chat-viewport.js';
import { createViewportObservability } from '../../src/cli/commands/chat-viewport-observability.js';
import type { AuditWriter } from '../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { createEventCollector } from '../helpers/event-collector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuditRow = [string, ...(string | number)[]];

interface AuditCapture {
  writer: AuditWriter;
  events: AuditRow[];
  filter: (type: string) => AuditRow[];
}

interface RegressionFixture {
  agentDir: string;
  streamPath: string;
  auditPath: string;
  fs: FileSystem;
  audit: AuditCapture;
  reader: StreamReader;
  mainUI: MainTurnUIController;
  observability: ReturnType<typeof createViewportObservability>;
  receivedEvents: readonly StreamEvent[];
  deliveryTimestamps: Array<{ type: string; ts: number }>;
  whenCount: (n: number) => Promise<void>;
  whenPredicate: (p: (events: readonly StreamEvent[]) => boolean) => Promise<void>;
  teardown: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapAuditCapture(realAudit: AuditWriter): AuditCapture {
  const events: AuditRow[] = [];
  const writer: AuditWriter = {
    ...realAudit,
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
      realAudit.write(type, ...cols);
    },
  } as AuditWriter;
  return {
    writer,
    events,
    filter: (type) => events.filter(([t]) => t === type),
  };
}

async function setupFixture(options?: { agentDirPrefix?: string }): Promise<RegressionFixture> {
  const agentDir = await createTempDir(options?.agentDirPrefix ?? 'phase165-viewport-');
  const streamPath = nativePath.join(agentDir, STREAM_FILE);
  const auditPath = nativePath.join(agentDir, AUDIT_FILE);

  const { fs, audit: realAudit } = createDirContext(agentDir);
  const audit = wrapAuditCapture(realAudit);

  // NEW (phase 759 step B / M#3+M#7+D7 align): fixture 经 StreamWriter own 路径 ensure stream file exists
  // phase 743 step B writer.open() 创空文件 + emit WRITER_OPEN_CREATED_EMPTY audit
  // 让 chokidar 监视已存 path / 后续 nativeFs.appendFile 'change' 在 CI 可靠
  // Reason: fixture 是 createStreamReader caller / 按 phase 743 step D jsdoc warning 落实 ensure file pattern
  const writer = new StreamWriter(fs, audit.writer);
  writer.open();
  const observability = createViewportObservability({ audit: audit.writer });

  const mainUI = createMainTurnUI({
    appendOutput: () => {},
    updateDisplay: () => {},
    trimOutputNewlines: false,
    getThinkingMode: () => 'off',
    audit: audit.writer,
    observability,
  });

  const ec = createEventCollector<StreamEvent>();
  const deliveryTimestamps: Array<{ type: string; ts: number }> = [];
  const reader = await new Promise<StreamReader>((resolve) => {
    const r = createStreamReader(
      fs,
      STREAM_FILE,
      (ev) => {
        ec.onEvent(ev);
        handleEventShim(ev, mainUI, observability);
        deliveryTimestamps.push({ type: ev.type, ts: performance.now() });
      },
      audit.writer,
      { persistent: false, onReady: () => resolve(r) },
    );
    r.start();
  });

  return {
    agentDir,
    streamPath,
    auditPath,
    fs,
    audit,
    reader,
    mainUI,
    observability,
    receivedEvents: ec.events,
    deliveryTimestamps,
    whenCount: ec.whenCount.bind(ec),
    whenPredicate: ec.whenPredicate.bind(ec),
    teardown: async () => {
      await reader.stop();
      await cleanupTempDir(agentDir);
    },
  };
}

function handleEventShim(
  ev: StreamEvent,
  mainUI: MainTurnUIController,
  observability: ReturnType<typeof createViewportObservability>,
): void {
  observability.recordEvent(ev.type);
  switch (ev.type) {
    case 'turn_start':
      mainUI.flushThinking();
      mainUI.flushStreaming();
      break;
    case 'llm_start':
      mainUI.flushThinking();
      mainUI.flushStreaming();
      mainUI.enterPhase('waiting_llm');
      break;
    case 'text_delta':
      mainUI.flushThinking();
      mainUI.enterPhase('streaming_text');
      mainUI.appendToBuffer(((ev as unknown) as { delta?: string }).delta ?? '');
      break;
    case 'tool_call': {
      mainUI.flushThinking();
      mainUI.flushStreaming();
      const name = ((ev as unknown) as { name?: string }).name ?? 'tool';
      mainUI.enterPhase('running_tool', name);
      break;
    }
    case 'tool_result':
      mainUI.enterPhase('idle');
      break;
    case 'turn_end':
      mainUI.enterPhase('idle');
      mainUI.flushStreaming();
      break;
    default:
      break;
  }
}

async function appendStreamEvent(fx: RegressionFixture, ev: object): Promise<void> {
  await nativeFs.appendFile(
    fx.streamPath,
    JSON.stringify({ ts: Date.now(), ...ev }) + '\n',
  );
}

function appendStreamRaw(fx: RegressionFixture, buf: Buffer): void {
  nativeAppend(fx.streamPath, buf);
}

async function waitForAudit(
  fx: RegressionFixture,
  type: string,
  count = 1,
  timeoutMs = 10000,
): Promise<AuditRow[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const matched = fx.audit.filter(type);
    if (matched.length >= count) return matched;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`waitForAudit timeout: type=${type} count=${count}; got ${fx.audit.filter(type).length}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat-viewport regression baseline', () => {
  const fixtures: RegressionFixture[] = [];

  afterEach(async () => {
    while (fixtures.length) {
      await fixtures.pop()!.teardown();
    }
  });

  async function bootstrapFixture(opts?: Parameters<typeof setupFixture>[0]) {
    const fx = await setupFixture(opts);
    fixtures.push(fx);
    return fx;
  }

  it('fixture scaffolding can setup and teardown', async () => {
    const fx = await bootstrapFixture();
    expect(fx.agentDir).toBeTruthy();
    expect(fx.streamPath.endsWith(STREAM_FILE)).toBe(true);
    expect(fx.auditPath.endsWith('audit.tsv')).toBe(true);
    expect(fx.reader.isActive()).toBe(true);

    await appendStreamEvent(fx, { type: 'turn_start' });
    await fx.whenCount(1);
    expect(fx.receivedEvents[0].type).toBe('turn_start');
  });

  it('基线 1：多行中文事件，chunk 边界拆中文字节时每行完整到达（STREAM_READER_PARSE_FAILED = 0）', async () => {
    const fx = await bootstrapFixture();

    const line1 = Buffer.from(JSON.stringify({ ts: 1, type: 'msg', text: '你好世界' }) + '\n', 'utf-8');
    const line2 = Buffer.from(JSON.stringify({ ts: 2, type: 'msg', text: '测试中文分 chunk' }) + '\n', 'utf-8');
    const line3 = Buffer.from(JSON.stringify({ ts: 3, type: 'msg', text: '边界验证 🎯' }) + '\n', 'utf-8');

    const all = Buffer.concat([line1, line2, line3]);

    const emojiByteIndex = all.indexOf(0xf0);
    expect(emojiByteIndex).toBeGreaterThan(0);

    const splitA = line1.length + Math.floor(line2.length / 2);
    const splitB = emojiByteIndex + 2;
    expect(splitA).toBeLessThan(splitB);
    expect(splitB).toBeLessThan(all.length);

    const chunkA = all.subarray(0, splitA);
    const chunkB = all.subarray(splitA, splitB);
    const chunkC = all.subarray(splitB);

    appendStreamRaw(fx, chunkA);
    await fx.whenCount(1);
    appendStreamRaw(fx, chunkB);
    await fx.whenCount(2);
    appendStreamRaw(fx, chunkC);

    await fx.whenCount(3);

    expect(fx.receivedEvents[0]).toMatchObject({ type: 'msg', text: '你好世界' });
    expect(fx.receivedEvents[1]).toMatchObject({ type: 'msg', text: '测试中文分 chunk' });
    expect(fx.receivedEvents[2]).toMatchObject({ type: 'msg', text: '边界验证 🎯' });

    const parseFailed = fx.audit.filter(STREAM_AUDIT_EVENTS.READER_PARSE_FAILED);
    expect(parseFailed.length).toBe(0);

    const corrupt = fx.audit.filter(STREAM_AUDIT_EVENTS.READER_CORRUPT);
    expect(corrupt.length).toBe(0);
  });

  it('基线 2：完整 turn 序列触发 Thinking + tool_name Spinner 生命周期 + VIEWPORT_EVENT_INGEST histogram', async () => {
    const fx = await bootstrapFixture();

    await appendStreamEvent(fx, { type: 'turn_start' });
    await fx.whenCount(1);

    await appendStreamEvent(fx, { type: 'llm_start' });
    await fx.whenCount(2);
    await waitForAudit(fx, VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, 1);

    await appendStreamEvent(fx, { type: 'text_delta', delta: '你好世界' });
    await fx.whenCount(3);
    await waitForAudit(fx, VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, 2);

    await appendStreamEvent(fx, { type: 'tool_call', name: 'exec' });
    await fx.whenCount(4);
    await waitForAudit(fx, VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, 3);

    await appendStreamEvent(fx, { type: 'tool_result', name: 'exec', success: true });
    await fx.whenCount(5);
    await waitForAudit(fx, VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, 4);

    await appendStreamEvent(fx, { type: 'turn_end' });
    await fx.whenCount(6);

    fx.observability.recordShutdown('stream_end');

    const spinnerEvents = fx.audit.filter(VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE);
    expect(spinnerEvents.length).toBeGreaterThanOrEqual(4);

    const hasStartThinking = spinnerEvents.some(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('action=start') && cols.includes('text=Thinking...');
    });
    expect(hasStartThinking).toBe(true);

    const hasStopThinking = spinnerEvents.some(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('action=stop') && cols.includes('text=Thinking...')
        && cols.some(c => c.startsWith('elapsed_ms='))
        && Number(cols.find(c => c.startsWith('elapsed_ms='))!.split('=')[1]) > 0;
    });
    expect(hasStopThinking).toBe(true);

    const hasStartExec = spinnerEvents.some(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('action=start') && cols.includes('text=exec...');
    });
    expect(hasStartExec).toBe(true);

    const hasStopExec = spinnerEvents.some(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('action=stop') && cols.includes('text=exec...')
        && cols.some(c => c.startsWith('elapsed_ms='))
        && Number(cols.find(c => c.startsWith('elapsed_ms='))!.split('=')[1]) > 0;
    });
    expect(hasStopExec).toBe(true);

    const ingestEvents = fx.audit.filter(VIEWPORT_AUDIT_EVENTS.EVENT_INGEST);
    expect(ingestEvents.length).toBeGreaterThanOrEqual(1);

    const allTypesCovered = new Set<string>();
    for (const row of ingestEvents) {
      const cols = row.slice(1) as string[];
      const typesCol = cols.find(c => c.startsWith('types='));
      if (!typesCol) continue;
      const histJson = typesCol.slice('types='.length);
      try {
        const hist = JSON.parse(histJson) as Record<string, number>;
        Object.keys(hist).forEach(k => allTypesCovered.add(k));
      } catch { /* 跳过 */ }
    }

    expect(allTypesCovered.has('llm_start')).toBe(true);
    expect(allTypesCovered.has('text_delta')).toBe(true);
    expect(allTypesCovered.has('tool_call')).toBe(true);
    expect(allTypesCovered.has('tool_result')).toBe(true);
    expect(allTypesCovered.has('turn_end')).toBe(true);

    expect(fx.audit.filter(STREAM_AUDIT_EVENTS.READER_PARSE_FAILED).length).toBe(0);
    expect(fx.audit.filter(STREAM_AUDIT_EVENTS.READER_CORRUPT).length).toBe(0);
  });

  it('基线 3：连续 10 轮 tool_call + tool_result 全部到达（防 [4/100] 漏类型回归）', async () => {
    const fx = await bootstrapFixture();

    const N = 10;

    await appendStreamEvent(fx, { type: 'turn_start' });

    for (let i = 1; i <= N; i++) {
      await appendStreamEvent(fx, { type: 'tool_call', step: i, name: 'exec' });
      await appendStreamEvent(fx, { type: 'tool_result', step: i, name: 'exec', success: true });
      await new Promise(r => setTimeout(r, 50));
    }

    await appendStreamEvent(fx, { type: 'turn_end' });

    await fx.whenCount(1 + N * 2 + 1);

    const toolCalls = fx.receivedEvents.filter(e => e.type === 'tool_call');
    const toolResults = fx.receivedEvents.filter(e => e.type === 'tool_result');
    expect(toolCalls).toHaveLength(N);
    expect(toolResults).toHaveLength(N);

    const callSteps = toolCalls.map(e => (e as unknown as { step: number }).step).sort((a, b) => a - b);
    const resultSteps = toolResults.map(e => (e as unknown as { step: number }).step).sort((a, b) => a - b);
    expect(callSteps).toEqual([1,2,3,4,5,6,7,8,9,10]);
    expect(resultSteps).toEqual([1,2,3,4,5,6,7,8,9,10]);

    fx.observability.recordShutdown('stream_end');

    const ingestEvents = fx.audit.filter(VIEWPORT_AUDIT_EVENTS.EVENT_INGEST);
    expect(ingestEvents.length).toBeGreaterThanOrEqual(1);

    let totalToolResult = 0;
    let totalToolCall = 0;
    for (const row of ingestEvents) {
      const cols = row.slice(1) as string[];
      const typesCol = cols.find(c => c.startsWith('types='));
      if (!typesCol) continue;
      const histJson = typesCol.slice('types='.length);
      try {
        const hist = JSON.parse(histJson) as Record<string, number>;
        totalToolResult += hist.tool_result ?? 0;
        totalToolCall += hist.tool_call ?? 0;
      } catch { /* skip */ }
    }
    expect(totalToolResult).toBe(N);
    expect(totalToolCall).toBe(N);

    expect(fx.audit.filter(STREAM_AUDIT_EVENTS.READER_PARSE_FAILED).length).toBe(0);
    expect(fx.audit.filter(STREAM_AUDIT_EVENTS.READER_CORRUPT).length).toBe(0);
  });

  it('基线 4：连续 ≥5 行畸形 JSON 触发 STREAM_READER_CORRUPT + 停订阅 + 哨兵阻断后续事件', async () => {
    const fx = await bootstrapFixture();

    expect(fx.reader.isActive()).toBe(true);

    for (let i = 0; i < 6; i++) {
      appendStreamRaw(fx, Buffer.from(`{broken_line_${i}\n`, 'utf-8'));
      await new Promise(r => setTimeout(r, 50));
    }

    await waitForAudit(fx, STREAM_AUDIT_EVENTS.READER_CORRUPT, 1);

    const corruptEvents = fx.audit.filter(STREAM_AUDIT_EVENTS.READER_CORRUPT);
    expect(corruptEvents.length).toBe(1);

    const cols = corruptEvents[0].slice(1) as string[];
    expect(cols.some(c => c.startsWith('path='))).toBe(true);
    expect(cols.some(c => c.startsWith('consecutive='))).toBe(true);
    expect(cols.some(c => c === 'trigger=consecutive_fail')).toBe(true);
    expect(cols.some(c => c.startsWith('recent_total='))).toBe(true);
    expect(cols.some(c => c.startsWith('recent_fail='))).toBe(true);

    const consecutiveCol = cols.find(c => c.startsWith('consecutive='))!;
    expect(Number(consecutiveCol.split('=')[1])).toBeGreaterThanOrEqual(5);

    expect(fx.reader.isActive()).toBe(false);

    const receivedBeforeCorrupt = fx.receivedEvents.length;

    await appendStreamEvent(fx, { type: 'post_corrupt_probe', ts: 999 });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(fx.receivedEvents.length).toBe(receivedBeforeCorrupt);
    expect(
      fx.receivedEvents.find(e => (e as unknown as { type: string }).type === 'post_corrupt_probe')
    ).toBeUndefined();

    expect(fx.audit.filter(STREAM_AUDIT_EVENTS.READER_PARSE_FAILED).length).toBeGreaterThanOrEqual(5);
  });

  it('基线 5：VIEWPORT_* 事件写 agentDir/audit.tsv，非父目录或其他路径（防 baseDir 归属漂回）', async () => {
    const fx = await bootstrapFixture();

    fx.mainUI.enterPhase('waiting_llm');
    await new Promise(r => setTimeout(r, 250)); // sleep: exceed MIN_DWELL_MS to ensure stop sync trigger
    fx.mainUI.enterPhase('idle');

    fx.mainUI.withScope('task', () => {
      fx.mainUI.clearPreview();
    });

    await new Promise(r => setTimeout(r, 50));

    const auditContent = await nativeFs.readFile(fx.auditPath, 'utf-8');
    expect(auditContent).toContain('viewport_spinner_lifecycle');
    expect(auditContent).toContain('viewport_ui_cross_pollution');

    expect(fx.auditPath.startsWith(fx.agentDir)).toBe(true);
    expect(fx.auditPath.endsWith(nativePath.sep + 'audit.tsv')).toBe(true);

    const parentDir = nativePath.dirname(fx.agentDir);
    const parentAuditPath = nativePath.join(parentDir, 'audit.tsv');
    let parentAuditContent = '';
    try {
      parentAuditContent = await nativeFs.readFile(parentAuditPath, 'utf-8');
    } catch {
      // 父目录 audit.tsv 不存在是理想状态
    }
    if (parentAuditContent) {
      const parentCrossPollution = parentAuditContent.split('\n').filter(l =>
        l.includes('viewport_ui_cross_pollution') && l.includes('method=clearPreview')
      );
      expect(parentCrossPollution.length).toBe(0);
    }

    expect(auditContent).toContain('method=clearPreview');
    expect(auditContent).toContain('source=task');
  });

  it('基线 6：Spinner start/stop 配对（计数相等 + 无 orphan + elapsed_ms 与实际时钟差吻合）', async () => {
    // phase 1176: wall-clock noise budget for Spinner elapsed_ms vs delivery timestamp diff
    const SPINNER_TOLERANCE_MS = 250;
    const fx = await bootstrapFixture();

    await appendStreamEvent(fx, { type: 'turn_start' });
    await fx.whenCount(1);

    const tLlmStart = Date.now(); // sanity: 测试线程 wall clock（不再参与断言）
    await appendStreamEvent(fx, { type: 'llm_start' });
    await fx.whenCount(2);
    await waitForAudit(fx, VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, 1);

    const tTextDelta = Date.now(); // sanity
    await appendStreamEvent(fx, { type: 'text_delta', delta: '你好' });
    await fx.whenCount(3);
    await waitForAudit(fx, VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, 2);

    const tToolCall = Date.now(); // sanity
    await appendStreamEvent(fx, { type: 'tool_call', name: 'exec' });
    await fx.whenCount(4);
    await waitForAudit(fx, VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, 3);

    const tToolResult = Date.now(); // sanity
    await appendStreamEvent(fx, { type: 'tool_result', name: 'exec', success: true });
    await fx.whenCount(5);
    await waitForAudit(fx, VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, 4);

    await appendStreamEvent(fx, { type: 'turn_end' });
    await fx.whenCount(6);

    const spinnerEvents = fx.audit.filter(VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE);

    const startRows = spinnerEvents.filter(row => (row.slice(1) as string[]).includes('action=start'));
    const stopRows = spinnerEvents.filter(row => (row.slice(1) as string[]).includes('action=stop'));

    expect(startRows.length).toBe(stopRows.length);
    expect(startRows.length).toBe(2);
    expect(stopRows.length).toBe(2);

    for (const row of stopRows) {
      const cols = row.slice(1) as string[];
      expect(cols.includes('orphan=1')).toBe(false);
    }

    // 同时钟域计算：deliveryTimestamps 与 spinner start/stop 同 callback clock
    const tcLlmStartEntry = fx.deliveryTimestamps.find(d => d.type === 'llm_start');
    const tcTextDeltaEntry = fx.deliveryTimestamps.find(d => d.type === 'text_delta');
    expect(tcLlmStartEntry).toBeDefined();
    expect(tcTextDeltaEntry).toBeDefined();
    const tcLlmStart = tcLlmStartEntry!.ts;
    const tcTextDelta = tcTextDeltaEntry!.ts;
    const expectedThinking = tcTextDelta - tcLlmStart;

    const stopThinking = stopRows.find(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('text=Thinking...');
    });
    expect(stopThinking).toBeDefined();
    const elapsedThinking = Number(
      (stopThinking!.slice(1) as string[])
        .find(c => c.startsWith('elapsed_ms='))!.split('=')[1]
    );
    expect(Math.abs(elapsedThinking - expectedThinking)).toBeLessThanOrEqual(SPINNER_TOLERANCE_MS);

    const tcToolCallEntry = fx.deliveryTimestamps.find(d => d.type === 'tool_call');
    const tcToolResultEntry = fx.deliveryTimestamps.find(d => d.type === 'tool_result');
    expect(tcToolCallEntry).toBeDefined();
    expect(tcToolResultEntry).toBeDefined();
    const tcToolCall = tcToolCallEntry!.ts;
    const tcToolResult = tcToolResultEntry!.ts;
    const expectedExec = tcToolResult - tcToolCall;

    const stopExec = stopRows.find(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('text=exec...');
    });
    expect(stopExec).toBeDefined();
    const elapsedExec = Number(
      (stopExec!.slice(1) as string[])
        .find(c => c.startsWith('elapsed_ms='))!.split('=')[1]
    );
    expect(Math.abs(elapsedExec - expectedExec)).toBeLessThanOrEqual(SPINNER_TOLERANCE_MS);

    expect(fx.audit.filter(STREAM_AUDIT_EVENTS.READER_PARSE_FAILED).length).toBe(0);
    expect(fx.audit.filter(STREAM_AUDIT_EVENTS.READER_CORRUPT).length).toBe(0);
  });
});
