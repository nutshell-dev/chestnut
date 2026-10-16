/**
 * chat-viewport-render-accounting tests — Phase 1942 Step B
 *
 * 逐帧终端写出观测与重复判定：
 * - 相同渲染状态的 requestRender 计入 repeatedRenderRequests（不含正文，仅稳定指纹）
 * - 实际 terminal write 边界的字节/hash/整帧证据；相同 bytes+hash 计入重复写出字节
 * - 局部内容变化 / preview 变化 / resize 不再判重
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createViewportObservability,
  isRepeatedRender,
  isRepeatedWrite,
  type RenderFingerprint,
  type TerminalWriteSample,
} from '../../src/viewport/chat-viewport-observability.js';
import {
  createScrollbackPreservingTerminal,
  hashTerminalWriteBytes,
  type ViewportTerminalLike,
} from '../../src/viewport/chat-viewport-terminal.js';
import { createDisplay } from '../../src/viewport/chat-viewport-display.js';
import type { MainTurnUIController } from '../../src/viewport/main-turn-ui.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/viewport/viewport-audit-events.js';

function makeObs() {
  const log: Array<[string, ...Array<string | number>]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => {
      log.push([type, ...cols]);
    },
  };
  let t = 0;
  const observability = createViewportObservability({ audit, clock: () => t });
  return { log, observability };
}

function fingerprint(overrides: Partial<RenderFingerprint> = {}): RenderFingerprint {
  return {
    width: 80,
    rows: 24,
    componentLineCount: 1,
    contentRevision: 0,
    previewRevision: 0,
    ...overrides,
  };
}

function writeSample(overrides: Partial<TerminalWriteSample> = {}): TerminalWriteSample {
  return { bytes: 3, hash: 0x1234, fullFrame: false, ...overrides };
}

describe('phase 1942 Step B: 重复判定纯函数', () => {
  it('isRepeatedRender：undefined 上一次 → 不重复；逐项相同 → 重复', () => {
    const fp = fingerprint();
    expect(isRepeatedRender(undefined, fp)).toBe(false);
    expect(isRepeatedRender(fp, fingerprint())).toBe(true);
  });

  it('isRepeatedRender：任一字段不同 → 不重复（width/rows/行数/两个 revision）', () => {
    const fp = fingerprint();
    expect(isRepeatedRender(fp, fingerprint({ width: 100 }))).toBe(false);
    expect(isRepeatedRender(fp, fingerprint({ rows: 40 }))).toBe(false);
    expect(isRepeatedRender(fp, fingerprint({ componentLineCount: 2 }))).toBe(false);
    expect(isRepeatedRender(fp, fingerprint({ contentRevision: 1 }))).toBe(false);
    expect(isRepeatedRender(fp, fingerprint({ previewRevision: 1 }))).toBe(false);
  });

  it('isRepeatedWrite：bytes+hash 相同 → 重复；fullFrame 差异不影响字节级重复判定', () => {
    const s = writeSample();
    expect(isRepeatedWrite(undefined, s)).toBe(false);
    expect(isRepeatedWrite(s, writeSample({ fullFrame: true }))).toBe(true);
    expect(isRepeatedWrite(s, writeSample({ bytes: 4 }))).toBe(false);
    expect(isRepeatedWrite(s, writeSample({ hash: 0x9999 }))).toBe(false);
  });
});

describe('phase 1942 Step B: recordRenderRequest 计数与 flush', () => {
  it('相同指纹连续请求 → repeated 计数；不同指纹 → 不重复', () => {
    const { observability } = makeObs();
    const fp = fingerprint();
    observability.recordRenderRequest(fp);
    observability.recordRenderRequest(fp);
    observability.recordRenderRequest(fingerprint({ previewRevision: 1 }));

    const acc = observability.getRenderAccounting();
    expect(acc.renderRequests).toBe(3);
    expect(acc.repeatedRenderRequests).toBe(1);
  });

  it('recordShutdown 先 flush render_request_batch 再写 SHUTDOWN', () => {
    const { log, observability } = makeObs();
    observability.recordRenderRequest(fingerprint());
    observability.recordRenderRequest(fingerprint());
    expect(log).toHaveLength(0);

    observability.recordShutdown('user_quit');
    expect(log).toHaveLength(2);
    expect(log[0][0]).toBe(VIEWPORT_AUDIT_EVENTS.RENDER_REQUEST_BATCH);
    expect(log[0]).toContain('requests=2');
    expect(log[0]).toContain('repeated=1');
    expect(log[1][0]).toBe(VIEWPORT_AUDIT_EVENTS.SHUTDOWN);
  });
});

describe('phase 1942 Step B: recordTerminalWrite 字节对账', () => {
  it('相同 bytes+hash 的连续写出 → 计入 repeatedWriteBytes；logicalContentBytes 只计一次', () => {
    const { observability } = makeObs();
    const sample = writeSample({ bytes: 10, hash: 7 });
    observability.recordTerminalWrite(sample);
    observability.recordTerminalWrite(sample);   // 重复
    observability.recordTerminalWrite(writeSample({ bytes: 5, hash: 8 }));  // 新内容

    const acc = observability.getRenderAccounting();
    expect(acc.terminalWrites).toBe(3);
    expect(acc.terminalWriteBytes).toBe(25);
    expect(acc.repeatedWrites).toBe(1);
    expect(acc.repeatedWriteBytes).toBe(10);
    expect(acc.logicalContentBytes).toBe(15);
    expect(acc.fullFrameWrites).toBe(0);
  });

  it('fullFrame 样本计入 fullFrameWrites；shutdown 先 flush terminal_write_batch', () => {
    const { log, observability } = makeObs();
    observability.recordTerminalWrite(writeSample({ bytes: 4, hash: 1, fullFrame: true }));
    observability.recordShutdown('user_quit');

    expect(observability.getRenderAccounting().fullFrameWrites).toBe(1);
    expect(log[0][0]).toBe(VIEWPORT_AUDIT_EVENTS.TERMINAL_WRITE_BATCH);
    expect(log[0]).toContain('writes=1');
    expect(log[0]).toContain('bytes=4');
    expect(log[0]).toContain('full_frames=1');
    expect(log[0]).toContain('repeated_bytes=0');
  });

  it('hashTerminalWriteBytes：稳定且区分内容', () => {
    expect(hashTerminalWriteBytes('abc')).toBe(hashTerminalWriteBytes('abc'));
    expect(hashTerminalWriteBytes('abc')).not.toBe(hashTerminalWriteBytes('abd'));
  });
});

describe('phase 1942 Step B: terminal adapter 写出证据（字节原样、仅计数/hash 出边界）', () => {
  function makeFakeTerminal(): { terminal: ViewportTerminalLike; writes: string[] } {
    const writes: string[] = [];
    const terminal: ViewportTerminalLike = {
      start: vi.fn(),
      stop: vi.fn(),
      drainInput: vi.fn(async () => { /* noop */ }),
      write: (data: string) => { writes.push(data); },
      get columns() { return 80; },
      get rows() { return 24; },
      get kittyProtocolActive() { return false; },
      moveBy: vi.fn(),
      hideCursor: vi.fn(),
      showCursor: vi.fn(),
      clearLine: vi.fn(),
      clearFromCursor: vi.fn(),
      clearScreen: vi.fn(),
      setTitle: vi.fn(),
    };
    return { terminal, writes };
  }

  it('onWrite 收到每次转发的 bytes/hash/fullFrame；字节流保持原样', () => {
    const { terminal, writes } = makeFakeTerminal();
    const samples: Array<{ bytes: number; hash: number; fullFrame: boolean }> = [];
    const wrapped = createScrollbackPreservingTerminal({
      inner: terminal,
      onWrite: (s) => samples.push(s),
    });

    wrapped.write('hello');
    wrapped.write('\x1b[2J\x1b[Hframe');

    expect(writes).toEqual(['hello', '\x1b[2J\x1b[Hframe']);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({ bytes: 5, hash: hashTerminalWriteBytes('hello'), fullFrame: false });
    expect(samples[1]).toEqual({ bytes: 12, hash: hashTerminalWriteBytes('\x1b[2J\x1b[Hframe'), fullFrame: true });
  });

  it('3J 过滤后证据基于实际转发 payload（被滤 chunk 无写出、无证据）', () => {
    const { terminal, writes } = makeFakeTerminal();
    const samples: Array<{ bytes: number; hash: number; fullFrame: boolean }> = [];
    const wrapped = createScrollbackPreservingTerminal({
      inner: terminal,
      onWrite: (s) => samples.push(s),
    });

    wrapped.write('\x1b[3J');
    expect(writes).toEqual([]);
    expect(samples).toHaveLength(0);
  });

  it('onWrite 抛异常不影响字节透传（诊断旁路隔离）', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({
      inner: terminal,
      onWrite: () => { throw new Error('diagnostic boom'); },
    });
    expect(() => wrapped.write('safe')).not.toThrow();
    expect(writes).toEqual(['safe']);
  });

  it('证据接线对账：adapter 两次相同整帧写出 → observability 记重复字节', () => {
    const { terminal } = makeFakeTerminal();
    const { observability } = makeObs();
    const wrapped = createScrollbackPreservingTerminal({
      inner: terminal,
      onWrite: (s) => observability.recordTerminalWrite(s),
    });
    const frame = '\x1b[2J\x1b[Hfull-frame-content';
    wrapped.write(frame);
    wrapped.write(frame);

    const acc = observability.getRenderAccounting();
    expect(acc.terminalWrites).toBe(2);
    expect(acc.fullFrameWrites).toBe(2);
    expect(acc.repeatedWrites).toBe(1);
    expect(acc.repeatedWriteBytes).toBe(frame.length);
  });
});

describe('phase 1942 Step B: display 层指纹——相同状态/局部变化/preview 变化/resize', () => {
  const originalColumnsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');

  afterEach(() => {
    if (originalColumnsDesc) {
      Object.defineProperty(process.stdout, 'columns', originalColumnsDesc);
    } else {
      delete (process.stdout as { columns?: number }).columns;
    }
  });

  function setColumns(cols: number) {
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  }

  function makeDisplayHarness() {
    const { observability } = makeObs();
    const requestRender = vi.fn();
    const setTextCalls: string[] = [];
    let status = '';
    let preview = '';
    const mainUI = {
      getStatus: () => status,
      getPreview: () => preview,
    } as unknown as MainTurnUIController;

    const display = createDisplay({
      label: 'test',
      outputText: { setText: (t: string) => { setTextCalls.push(t); } },
      tui: { requestRender },
      observability,
      mainUI,
      updateClawPanel: () => { /* noop */ },
      clawTrackMap: new Map(),
      spawnText: { setText: () => { /* noop */ } },
      shadowText: { setText: () => { /* noop */ } },
      migratedExecText: { setText: () => { /* noop */ } },
      taskStatusBar: {
        renderSpawn: () => '',
        renderShadow: () => '',
        renderMigratedExec: () => '',
      },
    });

    return {
      display,
      observability,
      requestRender,
      setTextCalls,
      setStatus: (s: string) => { status = s; },
      setPreviewText: (p: string) => { preview = p; },
    };
  }

  it('相同状态两次 updateDisplay → requestRender 被记录且第二次判重；字节计数不受影响', () => {
    setColumns(80);
    const h = makeDisplayHarness();
    h.display.updateDisplay();
    h.display.updateDisplay();

    expect(h.requestRender).toHaveBeenCalledTimes(2);
    const acc = h.observability.getRenderAccounting();
    expect(acc.renderRequests).toBe(2);
    expect(acc.repeatedRenderRequests).toBe(1);
  });

  it('局部内容变化（appendOutput）→ 新指纹，不判重', () => {
    setColumns(80);
    const h = makeDisplayHarness();
    h.display.updateDisplay();
    h.display.appendOutput('', 'new line');
    h.display.updateDisplay();

    const acc = h.observability.getRenderAccounting();
    // req1(A) → req2(B, appendOutput 内部 updateDisplay) → req3(B 再次 → 唯一一次重复)
    expect(acc.renderRequests).toBe(3);
    expect(acc.repeatedRenderRequests).toBe(1);
  });

  it('preview 变化 → previewRevision 推进，不判重', () => {
    setColumns(80);
    const h = makeDisplayHarness();
    h.display.updateDisplay();
    h.setPreviewText('streaming chunk');
    h.display.updateDisplay();

    const acc = h.observability.getRenderAccounting();
    expect(acc.repeatedRenderRequests).toBe(0);
  });

  it('resize（cols 变化）→ 指纹 width/contentRevision 推进，不判重', () => {
    setColumns(80);
    const h = makeDisplayHarness();
    h.display.updateDisplay();
    setColumns(100);
    h.display.onResize();

    const acc = h.observability.getRenderAccounting();
    expect(acc.repeatedRenderRequests).toBe(0);
  });

  it('requestRender 次数与 recordRenderRequest 计数一一对应', () => {
    setColumns(80);
    const h = makeDisplayHarness();
    h.display.updateDisplay();
    h.display.appendOutput('', 'a');
    h.setPreviewText('p');
    h.display.updateDisplay();

    expect(h.observability.getRenderAccounting().renderRequests)
      .toBe(h.requestRender.mock.calls.length);
  });
});
