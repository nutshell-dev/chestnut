import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

/**
 * 聚合阈值（B 类偏差）：启发式默认，smoke 后可调。
 *
 * **触发机制**：flush 仅在 `recordEvent` / `recordRender` 调用时检查时间阈值；
 * 无定时器。稀疏事件场景下 `span_ms` 可能远大于 FLUSH_MS —— 最后一批事件
 * 会在 `dispose()` / `recordShutdown()` 时兜底 flush。
 *
 * 语义后果：audit.tsv 里 `viewport_event_ingest` 的 `span_ms` 字段反映的是
 * "本批首条事件与末条事件"的跨度，不是"本批 flush 的真实时钟间隔"。
 */
export const VIEWPORT_OBS_CONFIG = {
  INGEST_BATCH_SIZE: 50,
  INGEST_FLUSH_MS: 1000,
  RENDER_BATCH_SIZE: 20,
  RENDER_FLUSH_MS: 500,
  // phase 1942 Step B: 逐帧写出观测批次（重复渲染请求 / 终端写出字节）
  RENDER_REQUEST_BATCH_SIZE: 20,
  RENDER_REQUEST_FLUSH_MS: 500,
  TERMINAL_WRITE_BATCH_SIZE: 20,
  TERMINAL_WRITE_FLUSH_MS: 500,
  SCROLLBACK_CLEAR_BATCH_SIZE: 50,
  SCROLLBACK_CLEAR_FLUSH_MS: 1000,
  // phase 1874 Step D: 宿主输入/全屏清除诊断面批次
  HOST_INPUT_BATCH_SIZE: 50,
  HOST_INPUT_FLUSH_MS: 1000,
  SCREEN_RESET_BATCH_SIZE: 10,
  SCREEN_RESET_FLUSH_MS: 1000,
} as const;

interface Deps {
  audit: { write: (type: string, ...cols: (string | number)[]) => void };
  clock?: () => number;
}

interface IngestBatch {
  size: number;
  types: Record<string, number>;
  firstTs: number;
}

interface RenderBatch {
  calls: number;
  totalMs: number;
  lastOutputLines: number;
  lastSuffixLines: number;
  firstTs: number;
}

interface ScrollbackClearBatch {
  count: number;
  firstTs: number;
}

/**
 * phase 1942 Step B: 渲染状态指纹（不含正文，仅几何 + 既有 revision 字段）。
 * 同一指纹再次 requestRender 计入重复请求——用于区分"真实内容变化"与"同一状态重复渲染"。
 */
export interface RenderFingerprint {
  width: number;
  rows: number;
  componentLineCount: number;
  contentRevision: number;
  previewRevision: number;
}

export function isRepeatedRender(
  previous: RenderFingerprint | undefined,
  current: RenderFingerprint,
): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(current);
}

/**
 * phase 1942 Step B: 终端写出样本（在实际转发 write 边界采集；hash 为稳定指纹、不含正文）。
 */
export interface TerminalWriteSample {
  bytes: number;
  hash: number;
  /** 写出 payload 含 CSI 2J（全屏清除 + 整帧重写路径的证据）。 */
  fullFrame: boolean;
}

export function isRepeatedWrite(
  previous: TerminalWriteSample | undefined,
  current: TerminalWriteSample,
): boolean {
  return (
    previous !== undefined &&
    previous.bytes === current.bytes &&
    previous.hash === current.hash
  );
}

/** phase 1942 Step B: 进程内可对账计数（RenderAccounting 口径，见 Phase 1942 总览 D2）。 */
export interface RenderAccounting {
  renderRequests: number;
  repeatedRenderRequests: number;
  terminalWrites: number;
  terminalWriteBytes: number;
  repeatedWriteBytes: number;
  repeatedWrites: number;
  fullFrameWrites: number;
  /** 真实内容字节 = 总写出字节 - 重复写出字节（同一状态只计一次）。 */
  logicalContentBytes: number;
}

interface RenderRequestBatch {
  requests: number;
  repeatedRequests: number;
  firstTs: number;
}

interface TerminalWriteBatch {
  writes: number;
  bytes: number;
  repeatedBytes: number;
  repeatedWrites: number;
  fullFrames: number;
  firstTs: number;
}

/** phase 1874 Step D: 宿主输入分类批次（计数、不含内容）。 */
export interface HostInputBatchCounts {
  chunks: number;
  printable: number;
  control: number;
  mouse: number;
  escape: number;
  paste: number;
}

interface HostInputBatch extends HostInputBatchCounts {
  firstTs: number;
}

interface ScreenResetBatch {
  count: number;
  firstTs: number;
}

export function createViewportObservability(deps: Deps) {
  const now = deps.clock ?? (() => performance.now());
  let ingest: IngestBatch | null = null;
  let render: RenderBatch | null = null;
  let scrollbackClear: ScrollbackClearBatch | null = null;
  let hostInput: HostInputBatch | null = null;
  let screenReset: ScreenResetBatch | null = null;
  // phase 1942 Step B: 逐帧写出观测状态（只持数字/hash，不持正文）
  let renderRequest: RenderRequestBatch | null = null;
  let terminalWrite: TerminalWriteBatch | null = null;
  let lastRenderFingerprint: RenderFingerprint | undefined;
  let lastWriteSample: TerminalWriteSample | undefined;
  const accounting: RenderAccounting = {
    renderRequests: 0,
    repeatedRenderRequests: 0,
    terminalWrites: 0,
    terminalWriteBytes: 0,
    repeatedWriteBytes: 0,
    repeatedWrites: 0,
    fullFrameWrites: 0,
    logicalContentBytes: 0,
  };
  let spinnerStartTs: number | null = null;

  const flushIngest = () => {
    if (!ingest) return;
    deps.audit.write(
      VIEWPORT_AUDIT_EVENTS.EVENT_INGEST,
      `batch_size=${ingest.size}`,
      `types=${JSON.stringify(ingest.types)}`,
      `span_ms=${now() - ingest.firstTs}`,
    );
    ingest = null;
  };

  const flushRender = () => {
    if (!render) return;
    deps.audit.write(
      VIEWPORT_AUDIT_EVENTS.RENDER_BATCH,
      `calls=${render.calls}`,
      `total_ms=${render.totalMs}`,
      `output_lines=${render.lastOutputLines}`,
      `suffix_lines=${render.lastSuffixLines}`,
    );
    render = null;
  };

  const flushScrollbackClear = () => {
    if (!scrollbackClear) return;
    deps.audit.write(
      VIEWPORT_AUDIT_EVENTS.SCROLLBACK_CLEAR_SUPPRESSED,
      `count=${scrollbackClear.count}`,
      `window_ms=${now() - scrollbackClear.firstTs}`,
    );
    scrollbackClear = null;
  };

  const flushHostInput = () => {
    if (!hostInput) return;
    deps.audit.write(
      VIEWPORT_AUDIT_EVENTS.HOST_INPUT,
      `chunks=${hostInput.chunks}`,
      `printable=${hostInput.printable}`,
      `control=${hostInput.control}`,
      `mouse=${hostInput.mouse}`,
      `escape=${hostInput.escape}`,
      `paste=${hostInput.paste}`,
      `span_ms=${now() - hostInput.firstTs}`,
    );
    hostInput = null;
  };

  const flushScreenReset = () => {
    if (!screenReset) return;
    deps.audit.write(
      VIEWPORT_AUDIT_EVENTS.SCREEN_RESET,
      `clears=${screenReset.count}`,
      `span_ms=${now() - screenReset.firstTs}`,
    );
    screenReset = null;
  };

  const flushRenderRequest = () => {
    if (!renderRequest) return;
    deps.audit.write(
      VIEWPORT_AUDIT_EVENTS.RENDER_REQUEST_BATCH,
      `requests=${renderRequest.requests}`,
      `repeated=${renderRequest.repeatedRequests}`,
      `span_ms=${now() - renderRequest.firstTs}`,
    );
    renderRequest = null;
  };

  const flushTerminalWrite = () => {
    if (!terminalWrite) return;
    deps.audit.write(
      VIEWPORT_AUDIT_EVENTS.TERMINAL_WRITE_BATCH,
      `writes=${terminalWrite.writes}`,
      `bytes=${terminalWrite.bytes}`,
      `repeated_bytes=${terminalWrite.repeatedBytes}`,
      `repeated_writes=${terminalWrite.repeatedWrites}`,
      `full_frames=${terminalWrite.fullFrames}`,
      `span_ms=${now() - terminalWrite.firstTs}`,
    );
    terminalWrite = null;
  };

  const recordEvent = (eventType: string) => {
    const t = now();
    if (!ingest) ingest = { size: 0, types: {}, firstTs: t };
    ingest.size += 1;
    ingest.types[eventType] = (ingest.types[eventType] ?? 0) + 1;
    if (
      ingest.size >= VIEWPORT_OBS_CONFIG.INGEST_BATCH_SIZE ||
      t - ingest.firstTs >= VIEWPORT_OBS_CONFIG.INGEST_FLUSH_MS
    ) {
      flushIngest();
    }
  };

  const recordRender = (meta: {
    outputLines: number;
    suffixLines: number;
    elapsedMs: number;
  }) => {
    const t = now();
    if (!render)
      render = {
        calls: 0,
        totalMs: 0,
        lastOutputLines: 0,
        lastSuffixLines: 0,
        firstTs: t,
      };
    render.calls += 1;
    render.totalMs += meta.elapsedMs;
    render.lastOutputLines = meta.outputLines;
    render.lastSuffixLines = meta.suffixLines;
    if (
      render.calls >= VIEWPORT_OBS_CONFIG.RENDER_BATCH_SIZE ||
      t - render.firstTs >= VIEWPORT_OBS_CONFIG.RENDER_FLUSH_MS
    ) {
      flushRender();
    }
  };

  /**
   * phase 1942 Step B: 记录一次 requestRender 的稳定状态指纹。
   * 指纹不含正文；与上一次相同 → repeated（同一渲染状态的重复请求）。
   */
  const recordRenderRequest = (fingerprint: RenderFingerprint) => {
    const t = now();
    const repeated = isRepeatedRender(lastRenderFingerprint, fingerprint);
    lastRenderFingerprint = fingerprint;
    accounting.renderRequests += 1;
    if (repeated) accounting.repeatedRenderRequests += 1;
    if (!renderRequest)
      renderRequest = { requests: 0, repeatedRequests: 0, firstTs: t };
    renderRequest.requests += 1;
    if (repeated) renderRequest.repeatedRequests += 1;
    if (
      renderRequest.requests >= VIEWPORT_OBS_CONFIG.RENDER_REQUEST_BATCH_SIZE ||
      t - renderRequest.firstTs >= VIEWPORT_OBS_CONFIG.RENDER_REQUEST_FLUSH_MS
    ) {
      flushRenderRequest();
    }
  };

  /**
   * phase 1942 Step B: 记录一次实际 terminal write（字节/hash/是否整帧）。
   * 与上一次写出完全相同（bytes+hash）→ 计入重复写出字节。
   */
  const recordTerminalWrite = (sample: TerminalWriteSample) => {
    const t = now();
    const repeated = isRepeatedWrite(lastWriteSample, sample);
    lastWriteSample = sample;
    accounting.terminalWrites += 1;
    accounting.terminalWriteBytes += sample.bytes;
    if (sample.fullFrame) accounting.fullFrameWrites += 1;
    if (repeated) {
      accounting.repeatedWriteBytes += sample.bytes;
      accounting.repeatedWrites += 1;
    }
    accounting.logicalContentBytes = accounting.terminalWriteBytes - accounting.repeatedWriteBytes;
    if (!terminalWrite)
      terminalWrite = {
        writes: 0,
        bytes: 0,
        repeatedBytes: 0,
        repeatedWrites: 0,
        fullFrames: 0,
        firstTs: t,
      };
    terminalWrite.writes += 1;
    terminalWrite.bytes += sample.bytes;
    if (sample.fullFrame) terminalWrite.fullFrames += 1;
    if (repeated) {
      terminalWrite.repeatedBytes += sample.bytes;
      terminalWrite.repeatedWrites += 1;
    }
    if (
      terminalWrite.writes >= VIEWPORT_OBS_CONFIG.TERMINAL_WRITE_BATCH_SIZE ||
      t - terminalWrite.firstTs >= VIEWPORT_OBS_CONFIG.TERMINAL_WRITE_FLUSH_MS
    ) {
      flushTerminalWrite();
    }
  };

  const recordSpinner = (action: 'start' | 'stop', text: string) => {
    if (action === 'start') {
      if (spinnerStartTs != null) {
        // 自动补 stop（连续 start 无中间 stop）
        deps.audit.write(
          VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE,
          `action=stop`,
          `text=${text}`,
          `elapsed_ms=${now() - spinnerStartTs}`,
        );
      }
      spinnerStartTs = now();
      deps.audit.write(
        VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE,
        `action=start`,
        `text=${text}`,
      );
    } else {
      const orphan = spinnerStartTs == null;
      const elapsed = orphan ? 0 : now() - spinnerStartTs!;
      spinnerStartTs = null;
      const cols: Array<string | number> = [
        `action=stop`,
        `text=${text}`,
        `elapsed_ms=${elapsed}`,
      ];
      if (orphan) cols.push('orphan=1');
      deps.audit.write(VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE, ...cols);
    }
  };

  /** phase 1874 Step D: 宿主输入分类计数（内容不经此面）。 */
  const recordHostInput = (counts: HostInputBatchCounts) => {
    const t = now();
    if (!hostInput) {
      hostInput = { chunks: 0, printable: 0, control: 0, mouse: 0, escape: 0, paste: 0, firstTs: t };
    }
    hostInput.chunks += counts.chunks;
    hostInput.printable += counts.printable;
    hostInput.control += counts.control;
    hostInput.mouse += counts.mouse;
    hostInput.escape += counts.escape;
    hostInput.paste += counts.paste;
    if (
      hostInput.chunks >= VIEWPORT_OBS_CONFIG.HOST_INPUT_BATCH_SIZE ||
      t - hostInput.firstTs >= VIEWPORT_OBS_CONFIG.HOST_INPUT_FLUSH_MS
    ) {
      flushHostInput();
    }
  };

  /** phase 1874 Step D: 全屏清除（CSI 2J）计数。 */
  const recordScreenReset = (count: number) => {
    const t = now();
    if (!screenReset) screenReset = { count: 0, firstTs: t };
    screenReset.count += count;
    if (
      screenReset.count >= VIEWPORT_OBS_CONFIG.SCREEN_RESET_BATCH_SIZE ||
      t - screenReset.firstTs >= VIEWPORT_OBS_CONFIG.SCREEN_RESET_FLUSH_MS
    ) {
      flushScreenReset();
    }
  };

  const recordScrollbackClearSuppressed = (count: number) => {
    const t = now();
    if (!scrollbackClear) scrollbackClear = { count: 0, firstTs: t };
    scrollbackClear.count += count;
    if (
      scrollbackClear.count >= VIEWPORT_OBS_CONFIG.SCROLLBACK_CLEAR_BATCH_SIZE ||
      t - scrollbackClear.firstTs >= VIEWPORT_OBS_CONFIG.SCROLLBACK_CLEAR_FLUSH_MS
    ) {
      flushScrollbackClear();
    }
  };

  const recordShutdown = (
    reason: 'daemon_dead' | 'user_quit' | 'stream_end',
  ) => {
    flushIngest();
    flushRender();
    flushScrollbackClear();
    flushHostInput();
    flushScreenReset();
    flushRenderRequest();
    flushTerminalWrite();
    deps.audit.write(VIEWPORT_AUDIT_EVENTS.SHUTDOWN, `reason=${reason}`);
  };

  const dispose = () => {
    flushIngest();
    flushRender();
    flushScrollbackClear();
    flushHostInput();
    flushScreenReset();
    flushRenderRequest();
    flushTerminalWrite();
  };

  /** phase 1942 Step B: 进程内 RenderAccounting 快照（Step D 长跑对账用；不含正文）。 */
  const getRenderAccounting = (): RenderAccounting => ({ ...accounting });

  return {
    recordEvent,
    recordRender,
    recordRenderRequest,
    recordTerminalWrite,
    getRenderAccounting,
    recordSpinner,
    recordScrollbackClearSuppressed,
    recordHostInput,
    recordScreenReset,
    recordShutdown,
    dispose,
  };
}
