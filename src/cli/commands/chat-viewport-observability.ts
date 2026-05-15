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

export function createViewportObservability(deps: Deps) {
  const now = deps.clock ?? (() => performance.now());
  let ingest: IngestBatch | null = null;
  let render: RenderBatch | null = null;
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

  const recordShutdown = (
    reason: 'daemon_dead' | 'user_quit' | 'stream_end',
  ) => {
    flushIngest();
    flushRender();
    deps.audit.write(VIEWPORT_AUDIT_EVENTS.SHUTDOWN, `reason=${reason}`);
  };

  const dispose = () => {
    flushIngest();
    flushRender();
  };

  return {
    recordEvent,
    recordRender,
    recordSpinner,
    recordShutdown,
    dispose,
  };
}
