import { describe, it, expect, afterEach } from 'vitest';
import { promises as nativeFs, appendFileSync as nativeAppend } from 'node:fs';
import * as nativePath from 'node:path';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createDirContext } from '../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
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
import { MIN_DWELL_MS } from '../../src/cli/commands/main-turn-ui.js';
import { SUBAGENT_LONG_TIMEOUT_MS } from '../helpers/test-timeouts.js';
import { createViewportObservability } from '../../src/cli/commands/chat-viewport-observability.js';
import type { AuditWriter } from '../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { createEventCollector } from '../helpers/event-collector.js';

/**
 * waitForAudit poll interval (phase 224 tighter from earlier value).
 * Derivation: < typical audit event flush (10ms) / 不漏窗 + 不过 busy-spin.
 */
const WAIT_FOR_AUDIT_POLL_MS = 5;

/**
 * Event-throttle mimic: gap between successive stream events to drive realistic chokidar batches.
 * Derivation: > chokidar tick / < INVERSE_WAITFOR window / 模真实 throttle 节奏.
 */
const EVENT_THROTTLE_MIMIC_MS = 50;

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
    preview: (s: string) => realAudit.preview(s),
    message: (s: string) => realAudit.message(s),
    summary: (s: string) => realAudit.summary(s),
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

  const { fs, audit: realAudit } = createDirContext({ fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }) }, agentDir);
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
  timeoutMs = SUBAGENT_LONG_TIMEOUT_MS,
): Promise<AuditRow[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const matched = fx.audit.filter(type);
    if (matched.length >= count) return matched;
    await new Promise(r => setTimeout(r, WAIT_FOR_AUDIT_POLL_MS));  // phase 224: tighter poll for waitForAudit
  }
  throw new Error(`waitForAudit timeout: type=${type} count=${count}; got ${fx.audit.filter(type).length}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat-viewport regression baseline — slow outliers', () => {
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

  it('基线 3：连续 10 轮 tool_call + tool_result 全部到达（防 [4/100] 漏类型回归）', async () => {
    const fx = await bootstrapFixture();

    const N = 10;

    await appendStreamEvent(fx, { type: 'turn_start' });

    for (let i = 1; i <= N; i++) {
      await appendStreamEvent(fx, { type: 'tool_call', step: i, name: 'exec' });
      await appendStreamEvent(fx, { type: 'tool_result', step: i, name: 'exec', success: true });
      await new Promise(r => setTimeout(r, EVENT_THROTTLE_MIMIC_MS));
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
      await new Promise(r => setTimeout(r, EVENT_THROTTLE_MIMIC_MS));
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
    // exceed MIN_DWELL_MS to ensure stop sync trigger; margin > pendingClearTimer schedule jitter
    const EXCEED_MARGIN_MS = 50;
    await new Promise(r => setTimeout(r, MIN_DWELL_MS + EXCEED_MARGIN_MS));
    fx.mainUI.enterPhase('idle');

    fx.mainUI.withScope('task', () => {
      fx.mainUI.clearPreview();
    });

    await new Promise(r => setTimeout(r, EVENT_THROTTLE_MIMIC_MS));

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

});
