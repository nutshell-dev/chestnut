import { describe, it, expect, afterEach } from 'vitest';
import { promises as nativeFs, appendFileSync as nativeAppend } from 'node:fs';
import * as nativePath from 'node:path';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createDirContext } from '../../src/cli/cli-factories.js';
import {
  createStreamReader,
  STREAM_FILE,
  type StreamReader,
  type StreamEvent,
} from '../../src/foundation/stream/index.js';
import { AUDIT_EVENTS } from '../../src/foundation/audit/events.js';
import { AUDIT_FILE } from '../../src/foundation/audit/index.js';
import {
  createMainTurnUI,
  type MainTurnUIController,
} from '../../src/cli/commands/chat-viewport.js';
import { createViewportObservability } from '../../src/cli/commands/chat-viewport-observability.js';
import type { AuditWriter } from '../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';

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
  receivedEvents: StreamEvent[];
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
  await nativeFs.writeFile(streamPath, '');

  const { fs, audit: realAudit } = createDirContext(agentDir);
  const audit = wrapAuditCapture(realAudit);
  const observability = createViewportObservability({ audit: audit.writer });

  const mainUI = createMainTurnUI({
    appendOutput: () => {},
    updateDisplay: () => {},
    trimOutputNewlines: false,
    getThinkingMode: () => 'off',
    audit: audit.writer,
    observability,
  });

  const receivedEvents: StreamEvent[] = [];
  const reader = createStreamReader(
    fs,
    STREAM_FILE,
    (ev) => {
      receivedEvents.push(ev);
      handleEventShim(ev, mainUI, observability);
    },
    audit.writer,
    { persistent: false },
  );
  reader.start();
  await new Promise(r => setTimeout(r, 300));

  return {
    agentDir,
    streamPath,
    auditPath,
    fs,
    audit,
    reader,
    mainUI,
    observability,
    receivedEvents,
    teardown: async () => {
      try { await reader.stop(); } catch {}
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
      mainUI.startSpinner();
      break;
    case 'text_delta':
      mainUI.stopSpinner();
      mainUI.appendToBuffer(((ev as unknown) as { delta?: string }).delta ?? '');
      break;
    case 'tool_call': {
      mainUI.stopSpinner();
      const name = ((ev as unknown) as { name?: string }).name ?? 'tool';
      mainUI.startSpinner(name);
      break;
    }
    case 'tool_result':
      mainUI.stopSpinner();
      break;
    case 'turn_end':
      mainUI.stopSpinner();
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

async function waitForEvents(fx: RegressionFixture, count: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fx.receivedEvents.length >= count) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`waitForEvents timeout: expected ${count}, got ${fx.receivedEvents.length}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat-viewport regression baseline', () => {
  const fixtures: RegressionFixture[] = [];

  afterEach(async () => {
    while (fixtures.length) {
      try { await fixtures.pop()!.teardown(); } catch {}
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
    await waitForEvents(fx, 1);
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
    await new Promise(r => setTimeout(r, 120));
    appendStreamRaw(fx, chunkB);
    await new Promise(r => setTimeout(r, 120));
    appendStreamRaw(fx, chunkC);

    await waitForEvents(fx, 3);

    expect(fx.receivedEvents[0]).toMatchObject({ type: 'msg', text: '你好世界' });
    expect(fx.receivedEvents[1]).toMatchObject({ type: 'msg', text: '测试中文分 chunk' });
    expect(fx.receivedEvents[2]).toMatchObject({ type: 'msg', text: '边界验证 🎯' });

    const parseFailed = fx.audit.filter(AUDIT_EVENTS.STREAM_READER_PARSE_FAILED);
    expect(parseFailed.length).toBe(0);

    const corrupt = fx.audit.filter(AUDIT_EVENTS.STREAM_READER_CORRUPT);
    expect(corrupt.length).toBe(0);
  });

  it('基线 2：完整 turn 序列触发 Thinking + tool_name Spinner lifecycle + VIEWPORT_EVENT_INGEST histogram', async () => {
    const fx = await bootstrapFixture();

    await appendStreamEvent(fx, { type: 'turn_start' });
    await new Promise(r => setTimeout(r, 150));

    await appendStreamEvent(fx, { type: 'llm_start' });
    await waitForEvents(fx, 2);
    await new Promise(r => setTimeout(r, 150));

    await appendStreamEvent(fx, { type: 'text_delta', delta: '你好世界' });
    await waitForEvents(fx, 3);
    await new Promise(r => setTimeout(r, 150));

    await appendStreamEvent(fx, { type: 'tool_call', name: 'exec' });
    await waitForEvents(fx, 4);
    await new Promise(r => setTimeout(r, 150));

    await appendStreamEvent(fx, { type: 'tool_result', name: 'exec', success: true });
    await waitForEvents(fx, 5);
    await new Promise(r => setTimeout(r, 150));

    await appendStreamEvent(fx, { type: 'turn_end' });
    await new Promise(r => setTimeout(r, 200));
    await waitForEvents(fx, 6);

    fx.observability.recordShutdown('stream_end');

    const spinnerEvents = fx.audit.filter(AUDIT_EVENTS.VIEWPORT_SPINNER_LIFECYCLE);
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
      return cols.includes('action=start') && cols.includes('text=exec');
    });
    expect(hasStartExec).toBe(true);

    const hasStopExec = spinnerEvents.some(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('action=stop') && cols.includes('text=exec')
        && cols.some(c => c.startsWith('elapsed_ms='))
        && Number(cols.find(c => c.startsWith('elapsed_ms='))!.split('=')[1]) > 0;
    });
    expect(hasStopExec).toBe(true);

    const ingestEvents = fx.audit.filter(AUDIT_EVENTS.VIEWPORT_EVENT_INGEST);
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

    expect(fx.audit.filter(AUDIT_EVENTS.STREAM_READER_PARSE_FAILED).length).toBe(0);
    expect(fx.audit.filter(AUDIT_EVENTS.STREAM_READER_CORRUPT).length).toBe(0);
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
    await new Promise(r => setTimeout(r, 200));

    await waitForEvents(fx, 1 + N * 2 + 1);

    const toolCalls = fx.receivedEvents.filter(e => e.type === 'tool_call');
    const toolResults = fx.receivedEvents.filter(e => e.type === 'tool_result');
    expect(toolCalls).toHaveLength(N);
    expect(toolResults).toHaveLength(N);

    const callSteps = toolCalls.map(e => (e as unknown as { step: number }).step).sort((a, b) => a - b);
    const resultSteps = toolResults.map(e => (e as unknown as { step: number }).step).sort((a, b) => a - b);
    expect(callSteps).toEqual([1,2,3,4,5,6,7,8,9,10]);
    expect(resultSteps).toEqual([1,2,3,4,5,6,7,8,9,10]);

    fx.observability.recordShutdown('stream_end');

    const ingestEvents = fx.audit.filter(AUDIT_EVENTS.VIEWPORT_EVENT_INGEST);
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

    expect(fx.audit.filter(AUDIT_EVENTS.STREAM_READER_PARSE_FAILED).length).toBe(0);
    expect(fx.audit.filter(AUDIT_EVENTS.STREAM_READER_CORRUPT).length).toBe(0);
  });

  it('基线 4：连续 ≥5 行畸形 JSON 触发 STREAM_READER_CORRUPT + 停订阅 + 哨兵阻断后续事件', async () => {
    const fx = await bootstrapFixture();

    expect(fx.reader.isActive()).toBe(true);

    for (let i = 0; i < 6; i++) {
      appendStreamRaw(fx, Buffer.from(`{broken_line_${i}\n`, 'utf-8'));
      await new Promise(r => setTimeout(r, 50));
    }

    await waitForAudit(fx, AUDIT_EVENTS.STREAM_READER_CORRUPT, 1);

    const corruptEvents = fx.audit.filter(AUDIT_EVENTS.STREAM_READER_CORRUPT);
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
    await new Promise(r => setTimeout(r, 200));

    expect(fx.receivedEvents.length).toBe(receivedBeforeCorrupt);
    expect(
      fx.receivedEvents.find(e => (e as unknown as { type: string }).type === 'post_corrupt_probe')
    ).toBeUndefined();

    expect(fx.audit.filter(AUDIT_EVENTS.STREAM_READER_PARSE_FAILED).length).toBeGreaterThanOrEqual(5);
  });

  it('基线 5：VIEWPORT_* 事件写 agentDir/audit.tsv，非父目录或其他路径（防 baseDir 归属漂回）', async () => {
    const fx = await bootstrapFixture();

    fx.mainUI.startSpinner();
    fx.mainUI.stopSpinner();

    fx.mainUI.withScope('task', () => {
      fx.mainUI.clearSuffix();
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
        l.includes('viewport_ui_cross_pollution') && l.includes('method=clearSuffix')
      );
      expect(parentCrossPollution.length).toBe(0);
    }

    expect(auditContent).toContain('method=clearSuffix');
    expect(auditContent).toContain('source=task');
  });

  it('基线 6：Spinner start/stop 配对（计数相等 + 无 orphan + elapsed_ms 与实际时钟差吻合）', async () => {
    const fx = await bootstrapFixture();

    await appendStreamEvent(fx, { type: 'turn_start' });
    await waitForEvents(fx, 1);
    await new Promise(r => setTimeout(r, 100));

    const tLlmStart = Date.now();
    await appendStreamEvent(fx, { type: 'llm_start' });
    await waitForEvents(fx, 2);
    await new Promise(r => setTimeout(r, 100));

    const tTextDelta = Date.now();
    await appendStreamEvent(fx, { type: 'text_delta', delta: '你好' });
    await waitForEvents(fx, 3);
    await new Promise(r => setTimeout(r, 100));

    const tToolCall = Date.now();
    await appendStreamEvent(fx, { type: 'tool_call', name: 'exec' });
    await waitForEvents(fx, 4);
    await new Promise(r => setTimeout(r, 100));

    const tToolResult = Date.now();
    await appendStreamEvent(fx, { type: 'tool_result', name: 'exec', success: true });
    await waitForEvents(fx, 5);
    await new Promise(r => setTimeout(r, 100));

    await appendStreamEvent(fx, { type: 'turn_end' });
    await waitForEvents(fx, 6);

    const spinnerEvents = fx.audit.filter(AUDIT_EVENTS.VIEWPORT_SPINNER_LIFECYCLE);

    const startRows = spinnerEvents.filter(row => (row.slice(1) as string[]).includes('action=start'));
    const stopRows = spinnerEvents.filter(row => (row.slice(1) as string[]).includes('action=stop'));

    expect(startRows.length).toBe(stopRows.length);
    expect(startRows.length).toBe(2);
    expect(stopRows.length).toBe(2);

    for (const row of stopRows) {
      const cols = row.slice(1) as string[];
      expect(cols.includes('orphan=1')).toBe(false);
    }

    const TOLERANCE_MS = 100;

    const stopThinking = stopRows.find(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('text=Thinking...');
    });
    expect(stopThinking).toBeDefined();
    const elapsedThinking = Number(
      (stopThinking!.slice(1) as string[])
        .find(c => c.startsWith('elapsed_ms='))!.split('=')[1]
    );
    const expectedThinking = tTextDelta - tLlmStart;
    expect(Math.abs(elapsedThinking - expectedThinking)).toBeLessThanOrEqual(TOLERANCE_MS);

    const stopExec = stopRows.find(row => {
      const cols = row.slice(1) as string[];
      return cols.includes('text=exec');
    });
    expect(stopExec).toBeDefined();
    const elapsedExec = Number(
      (stopExec!.slice(1) as string[])
        .find(c => c.startsWith('elapsed_ms='))!.split('=')[1]
    );
    const expectedExec = tToolResult - tToolCall;
    expect(Math.abs(elapsedExec - expectedExec)).toBeLessThanOrEqual(TOLERANCE_MS);

    expect(fx.audit.filter(AUDIT_EVENTS.STREAM_READER_PARSE_FAILED).length).toBe(0);
    expect(fx.audit.filter(AUDIT_EVENTS.STREAM_READER_CORRUPT).length).toBe(0);
  });
});
