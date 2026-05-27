import { describe, it, expect } from 'vitest';
import {
  createViewportObservability,
  VIEWPORT_OBS_CONFIG,
} from '../../src/cli/commands/chat-viewport-observability.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/cli/commands/viewport-audit-events.js';

describe('chat-viewport-observability', () => {
  function makeDeps() {
    const log: Array<[string, ...Array<string | number>]> = [];
    const audit = {
      write: (type: string, ...cols: (string | number)[]) => {
        log.push([type, ...cols]);
      },
    };
    let t = 0;
    const clock = () => t;
    const advance = (ms: number) => {
      t += ms;
    };
    const observability = createViewportObservability({ audit, clock });
    return { log, audit, clock, advance, observability };
  }

  it('事件数阈值触发 flush', () => {
    const { log, audit, clock } = makeDeps();
    const obs = createViewportObservability({ audit, clock });

    for (let i = 0; i < VIEWPORT_OBS_CONFIG.INGEST_BATCH_SIZE; i++) {
      obs.recordEvent(i % 2 === 0 ? 'turn_start' : 'text_delta');
    }

    expect(log).toHaveLength(1);
    expect(log[0][0]).toBe(VIEWPORT_AUDIT_EVENTS.EVENT_INGEST);
    expect(log[0][1]).toBe(`batch_size=${VIEWPORT_OBS_CONFIG.INGEST_BATCH_SIZE}`);
    expect(log[0][2]).toBe('types={"turn_start":25,"text_delta":25}');
  });

  it('时间阈值触发 flush', () => {
    const { log, audit, clock, advance } = makeDeps();
    const obs = createViewportObservability({ audit, clock });

    obs.recordEvent('turn_start');
    advance(400);
    obs.recordEvent('text_delta');
    advance(400);
    obs.recordEvent('text_delta');
    // 此时 span_ms = 800，尚未触发
    expect(log).toHaveLength(0);

    advance(201);
    obs.recordEvent('turn_end');
    // 首条到本条 span_ms = 1001 >= INGEST_FLUSH_MS，触发 flush
    expect(log).toHaveLength(1);
    expect(log[0][0]).toBe(VIEWPORT_AUDIT_EVENTS.EVENT_INGEST);
    expect(log[0][1]).toBe('batch_size=4');
    const spanCol = log[0][3] as string;
    expect(spanCol).toMatch(/^span_ms=\d+$/);
    const spanMs = parseInt(spanCol.replace('span_ms=', ''), 10);
    expect(spanMs).toBeGreaterThanOrEqual(1001);
  });

  it('Spinner start→stop 的 elapsed_ms；连续 stop / 连续 start 边界', () => {
    const { log, audit, clock, advance } = makeDeps();
    const obs = createViewportObservability({ audit, clock });

    // 正常 start → 500ms → stop
    obs.recordSpinner('start', 'Thinking...');
    advance(500);
    obs.recordSpinner('stop', 'Thinking...');

    expect(log).toHaveLength(2);
    expect(log[0]).toEqual([
      VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE,
      'action=start',
      'text=Thinking...',
    ]);
    expect(log[1]).toEqual([
      VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE,
      'action=stop',
      'text=Thinking...',
      'elapsed_ms=500',
    ]);

    // 连续 stop（无前置 start）→ elapsed_ms=0, orphan=1
    obs.recordSpinner('stop', 'Done');
    expect(log).toHaveLength(3);
    expect(log[2]).toEqual([
      VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE,
      'action=stop',
      'text=Done',
      'elapsed_ms=0',
      'orphan=1',
    ]);

    // 连续 start（无中间 stop）→ 自动补 stop，再写新 start
    log.length = 0;
    obs.recordSpinner('start', 'A');
    advance(100);
    obs.recordSpinner('start', 'B');

    expect(log).toHaveLength(3);
    expect(log[0]).toEqual([
      VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE,
      'action=start',
      'text=A',
    ]);
    expect(log[1]).toEqual([
      VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE,
      'action=stop',
      'text=B',
      'elapsed_ms=100',
    ]);
    expect(log[2]).toEqual([
      VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE,
      'action=start',
      'text=B',
    ]);
  });

  it('recordShutdown 先 flush 再写 SHUTDOWN', () => {
    const { log, audit, clock } = makeDeps();
    const obs = createViewportObservability({ audit, clock });

    obs.recordEvent('turn_start');
    obs.recordEvent('text_delta');
    expect(log).toHaveLength(0); // 未满批次

    obs.recordShutdown('user_quit');
    expect(log).toHaveLength(2);
    expect(log[0][0]).toBe(VIEWPORT_AUDIT_EVENTS.EVENT_INGEST);
    expect(log[1][0]).toBe(VIEWPORT_AUDIT_EVENTS.SHUTDOWN);
    expect(log[1][1]).toBe('reason=user_quit');
  });

  it('recordShutdown 之后即使再调 recordSpinner，也不影响 SHUTDOWN 时序', () => {
    const { log, observability, advance } = makeDeps();
    observability.recordSpinner('start', 'Thinking...');
    advance(100);
    observability.recordShutdown('user_quit');
    // 模拟 cleanup 外部误调 enterPhase('idle')（本 Step 杜绝但留回归测试兜底）
    observability.recordSpinner('stop', 'Thinking...');

    const types = log.map(([t]) => t);
    const shutdownIdx = types.indexOf(VIEWPORT_AUDIT_EVENTS.SHUTDOWN);
    const lastSpinnerIdx = types.lastIndexOf(VIEWPORT_AUDIT_EVENTS.SPINNER_LIFECYCLE);
    // 该断言记录当前行为（spinner 在 shutdown 之后）——
    // 真正的时序保证在 chat-viewport.ts 层，不在工厂层。
    // 本测试只防退化：chat-viewport 之外若有消费者需此不变量，应自行保证调用序。
    expect(shutdownIdx).toBeGreaterThan(-1);
    expect(lastSpinnerIdx).toBeGreaterThan(shutdownIdx); // 文档化"工厂不保证"
  });

  it('recordShutdown 在未满批次时先 flush INGEST 再写 SHUTDOWN', () => {
    const { log, observability } = makeDeps();
    observability.recordEvent('turn_start');
    observability.recordEvent('llm_start');
    observability.recordShutdown('user_quit');

    const seq = log.map(([t]) => t).filter(
      (t) => t === VIEWPORT_AUDIT_EVENTS.EVENT_INGEST || t === VIEWPORT_AUDIT_EVENTS.SHUTDOWN,
    );
    expect(seq).toEqual([
      VIEWPORT_AUDIT_EVENTS.EVENT_INGEST,
      VIEWPORT_AUDIT_EVENTS.SHUTDOWN,
    ]);
    const shutdown = log.find(([t]) => t === VIEWPORT_AUDIT_EVENTS.SHUTDOWN)!;
    expect(shutdown).toContain('reason=user_quit');
  });

  it('孤 stop 追加 orphan=1，正常 stop 不加', () => {
    const { log, observability, advance } = makeDeps();
    // 孤 stop
    observability.recordSpinner('stop', 'X');
    const orphanRow = log[log.length - 1];
    expect(orphanRow).toContain('elapsed_ms=0');
    expect(orphanRow).toContain('orphan=1');

    // 正常 start → stop
    observability.recordSpinner('start', 'Y');
    advance(50);
    observability.recordSpinner('stop', 'Y');
    const normalRow = log[log.length - 1];
    expect(normalRow).toContain('elapsed_ms=50');
    expect(normalRow.some((c) => typeof c === 'string' && c === 'orphan=1')).toBe(false);
  });
});
