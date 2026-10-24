import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMainTurnUI } from '../../src/viewport/main-turn-ui.js';
import { MIN_DWELL_MS } from '../../src/viewport/main-turn-ui.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/viewport/viewport-audit-events.js';

describe('MainTurnUIController', () => {
  const makeDeps = () => ({
    appendOutput: vi.fn(),
    updateDisplay: vi.fn(),
    trimOutputNewlines: true,
    getThinkingMode: vi.fn(() => 'full' as const),
    audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)},
  });

  it('正常 main scope 下写操作不触发 audit', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('main', () => {
      mainUI.setPreview({ kind: 'text', text: 'hello', streaming: false });
      mainUI.enterPhase('waiting_llm');
      mainUI.appendToBuffer('world');
    });

    expect(deps.audit.write).not.toHaveBeenCalled();
    expect(deps.updateDisplay).toHaveBeenCalled();
  });

  it('task scope 下写主 UI 触发 viewport_ui_cross_pollution audit', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('task', () => {
      mainUI.setPreview({ kind: 'text', text: 'polluted', streaming: false });
    });

    expect(deps.audit.write).toHaveBeenCalledTimes(1);
    expect(deps.audit.write).toHaveBeenCalledWith(
      VIEWPORT_AUDIT_EVENTS.UI_CROSS_POLLUTION,
      'method=setPreview',
      'source=task',
    );
  });

  it('task scope 下多个写操作各自触发 audit', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('task', () => {
      mainUI.setPreview({ kind: 'text', text: 'a', streaming: false });
      mainUI.clearPreview();
      mainUI.enterPhase('waiting_llm');
      mainUI.enterPhase('idle');
      mainUI.appendToBuffer('b');
      mainUI.flushStreaming();
      mainUI.appendToThinking('c');
      mainUI.flushThinking();
    });

    expect(deps.audit.write.mock.calls.length).toBeGreaterThanOrEqual(8);
    const methods = deps.audit.write.mock.calls.map((c: unknown[]) => c[1]);
    expect(methods).toContain('method=setPreview');
    expect(methods).toContain('method=clearPreview');
    expect(methods).toContain('method=enterPhase:waiting_llm');
    expect(methods).toContain('method=enterPhase:idle');
    expect(methods).toContain('method=appendToBuffer');
    expect(methods).toContain('method=flushStreaming');
    expect(methods).toContain('method=appendToThinking');
    expect(methods).toContain('method=flushThinking');
  });

  it('system scope 下写操作不触发 audit', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('system', () => {
      mainUI.setPreview({ kind: 'text', text: 'system', streaming: false });
    });

    expect(deps.audit.write).not.toHaveBeenCalled();
  });

  it('withScope 嵌套时恢复上一 scope', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('main', () => {
      mainUI.setPreview({ kind: 'text', text: 'outer', streaming: false });
      expect(deps.audit.write).not.toHaveBeenCalled();

      mainUI.withScope('task', () => {
        mainUI.setPreview({ kind: 'text', text: 'inner', streaming: false });
        expect(deps.audit.write).toHaveBeenCalledTimes(1);
      });

      mainUI.setPreview({ kind: 'text', text: 'outer-again', streaming: false });
      expect(deps.audit.write).toHaveBeenCalledTimes(1);
    });
  });

  it('withScope 异常时仍恢复 scope', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    expect(() => {
      mainUI.withScope('task', () => {
        throw new Error('boom');
      });
    }).toThrow('boom');

    mainUI.withScope('main', () => {
      mainUI.setPreview({ kind: 'text', text: 'safe', streaming: false });
    });
    expect(deps.audit.write).not.toHaveBeenCalled();
  });

  it('appendToBuffer 返回更新后的 buffer', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    expect(mainUI.appendToBuffer('hello')).toBe('hello');
    expect(mainUI.appendToBuffer(' world')).toBe('hello world');
  });

  it('appendToThinking 返回更新后的 buffer', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    expect(mainUI.appendToThinking('think')).toBe('think');
    expect(mainUI.appendToThinking('ing')).toBe('thinking');
  });

  // —— 新增：双槽独立 ——
  it('status 与 preview 双槽独立、互不覆盖', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.enterPhase('waiting_llm');
    mainUI.setPreview({ kind: 'text', text: 'preview text', streaming: false });

    expect(mainUI.getStatus()).toMatch(/Thinking/);
    expect(mainUI.getPreviewLines()).toEqual([{ text: '⏺ preview text', style: 'dim' }]);
  });

  // —— 新增：min-dwell 反向防同 tick 塌缩 ——
  it('同 tick enterPhase waiting_llm → streaming_text，status slot 仍保留 spinner（dwell 内推迟 clear）', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const mainUI = createMainTurnUI(deps);

      mainUI.enterPhase('waiting_llm');
      const statusAfterEnter = mainUI.getStatus();
      expect(statusAfterEnter).toMatch(/Thinking/);

      mainUI.enterPhase('streaming_text');
      // dwell 内未到期、status slot 仍有 spinner（pendingClear 已 schedule 但未 fire）
      expect(mainUI.getStatus()).toMatch(/Thinking/);
      expect(mainUI.getPhase()).toBe('streaming_text');

      // 推过 dwell + 一帧
      await vi.advanceTimersByTimeAsync(250);
      expect(mainUI.getStatus()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  // —— 新增：dwell 内切回 spinner 类 phase 取消 pendingClear ——
  it('dwell 内切回 waiting_llm，spinner 不被 pendingClear 误清', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const mainUI = createMainTurnUI(deps);

      mainUI.enterPhase('waiting_llm');
      mainUI.enterPhase('streaming_text');         // schedule pendingClear
      mainUI.enterPhase('waiting_llm');            // 应 cancel pendingClear

      await vi.advanceTimersByTimeAsync(300);
      expect(mainUI.getStatus()).toMatch(/Thinking/);
    } finally {
      vi.useRealTimers();
    }
  });

  // —— 新增：tool spinner label 切换无缝 ——
  it('waiting_llm → running_tool 切换 label 不重置 dwell 起点', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const calls: Array<[string, string]> = [];
      const mainUI2 = createMainTurnUI({
        ...deps,
        observability: { recordSpinner: (a, t) => calls.push([a, t]) },
      });

      mainUI2.enterPhase('waiting_llm');
      mainUI2.enterPhase('running_tool', 'exec');

      // 仅 1 次 start（waiting_llm），label 切换不再产 start
      expect(calls.filter(c => c[0] === 'start')).toHaveLength(1);
      expect(mainUI2.getStatus()).toMatch(/exec\.\.\./);
    } finally {
      vi.useRealTimers();
    }
  });

  // —— 新增：getPhase 返回当前 phase ——
  it('getPhase 反映 enterPhase 的最新值', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    expect(mainUI.getPhase()).toBe('idle');
    mainUI.enterPhase('waiting_llm');
    expect(mainUI.getPhase()).toBe('waiting_llm');
    mainUI.enterPhase('running_tool', 'foo');
    expect(mainUI.getPhase()).toBe('running_tool');
  });

  // —— phase 881: fresh-restart dwell continuity ——
  describe('phase 881: fresh-restart dwell continuity', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('fresh-restart within MIN_DWELL_MS preserves dwell continuity', () => {
      const recordSpinner = vi.fn();
      const deps = makeDeps();
      const ui = createMainTurnUI({ ...deps, observability: { recordSpinner } });

      // cycle 1: start → stop with dwell defer
      ui.enterPhase('waiting_llm');
      vi.advanceTimersByTime(50);
      ui.enterPhase('streaming_text');   // stopSpinnerWithDwell, schedule pendingClearTimer 150ms
      // cycle 1 真 stop at T0+200
      vi.advanceTimersByTime(150);
      // 此时 pendingClearTimer fired, stopSpinnerNow ran, spinnerStopTs ≈ T0+200

      // cycle 2: fresh restart at T0+(MIN_DWELL_MS+5) (within MIN_DWELL_MS from stop)
      vi.advanceTimersByTime(5);
      ui.enterPhase('waiting_llm');   // startSpinner fresh 分支
      // continuity 分支应触发：spinnerStartTs ≈ T0+6 (virtual, T0+205 - 199)

      // cycle 2 内 quick stop at T0+220 (15ms after restart)
      vi.advanceTimersByTime(15);
      ui.enterPhase('streaming_text');   // stopSpinnerWithDwell
      // 由于 continuity 保，elapsed (T0+220 - T0+6) = 214 ≥ MIN_DWELL_MS → immediate stop ✓
      // 验：stopSpinner 立即触发（不再 schedule pendingClearTimer）
      expect(recordSpinner).toHaveBeenCalledWith('stop', expect.any(String));
      expect(recordSpinner.mock.calls.filter(c => c[0] === 'stop').length).toBe(2);
    });

    it('fresh-restart after MIN_DWELL_MS starts new cycle', () => {
      const recordSpinner = vi.fn();
      const deps = makeDeps();
      const ui = createMainTurnUI({ ...deps, observability: { recordSpinner } });

      // cycle 1
      ui.enterPhase('waiting_llm');
      vi.advanceTimersByTime(MIN_DWELL_MS);
      ui.enterPhase('streaming_text');   // elapsed=MIN_DWELL_MS → stop immediate
      // 此时 spinnerStopTs ≈ T0+200

      // cycle 2: 等 1 秒后 start（> MIN_DWELL_MS from stop）
      vi.advanceTimersByTime(1000);
      ui.enterPhase('waiting_llm');   // fresh 分支：真新 cycle
      // spinnerStartTs ≈ T0+1200 (now)

      // cycle 2 quick stop at T0+1220
      vi.advanceTimersByTime(20);
      ui.enterPhase('streaming_text');
      // elapsed=20 < MIN_DWELL → schedule pendingClearTimer 180ms
      // 验：stop 未立即触发（pendingClearTimer scheduled）
      expect(recordSpinner.mock.calls.filter(c => c[0] === 'stop').length).toBe(1);   // cycle 1 stop only
      vi.advanceTimersByTime(180);
      expect(recordSpinner.mock.calls.filter(c => c[0] === 'stop').length).toBe(2);   // cycle 2 stop after dwell
    });
  });

  // —— phase 1306: preview 清理唯一归 clearPreview ——
  it('flushStreaming with empty buffer 不触发任何动作、不动 preview（preview 清理唯一归 clearPreview）', () => {
    const updateDisplaySpy = vi.fn();
    const deps = { ...makeDeps(), updateDisplay: updateDisplaySpy };
    const ui = createMainTurnUI(deps);
    ui.setPreview({ kind: 'text', text: 'stale', streaming: false });
    updateDisplaySpy.mockClear();
    ui.flushStreaming();   // streamingBuffer empty
    expect(updateDisplaySpy).not.toHaveBeenCalled();
    expect(ui.getPreviewLines()).toEqual([{ text: '⏺ stale', style: 'dim' }]);
  });

  it('flushStreaming 落盘后不写 preview（preview 清理唯一归 clearPreview）', () => {
    const updateDisplaySpy = vi.fn();
    const deps = { ...makeDeps(), updateDisplay: updateDisplaySpy };
    const ui = createMainTurnUI(deps);
    ui.appendToBuffer('hello');
    ui.setPreview({ kind: 'text', text: 'preview-stale', streaming: false });
    updateDisplaySpy.mockClear();
    ui.flushStreaming();
    expect(deps.appendOutput).toHaveBeenCalled();
    expect(ui.getPreviewLines()).toEqual([{ text: '⏺ preview-stale', style: 'dim' }]);
  });

  it('clearPreview 清 preview 并触发 updateDisplay', () => {
    const updateDisplaySpy = vi.fn();
    const deps = { ...makeDeps(), updateDisplay: updateDisplaySpy };
    const ui = createMainTurnUI(deps);
    ui.setPreview({ kind: 'text', text: 'x', streaming: false });
    updateDisplaySpy.mockClear();
    ui.clearPreview();
    expect(ui.getPreviewLines()).toEqual([]);
    expect(updateDisplaySpy).toHaveBeenCalled();
  });

  // —— phase 1992 Step B: PreviewBlock 唯一 renderer ——
  describe('phase 1992 Step B: PreviewBlock renderer（首行前缀/续行 2 空格/逐行 style）', () => {
    it('多行 thinking preview：首行 ⏺ [thinking]、续行 2 空格、全 dim', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.setPreview({ kind: 'thinking', text: 'line1\nline2\nline3' });
      expect(ui.getPreviewLines()).toEqual([
        { text: '⏺ [thinking] line1', style: 'dim' },
        { text: '  line2', style: 'dim' },
        { text: '  line3', style: 'dim' },
      ]);
    });

    it('多行 text preview：首行 ⏺、续行 2 空格、dim；streaming 时行尾带 ▋', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.setPreview({ kind: 'text', text: 'a\nb', streaming: true });
      // cursor 追加在 buffer 末尾（多行时为最后一行行尾），与旧 prefixLines(buf + '▋') 一致
      expect(ui.getPreviewLines()).toEqual([
        { text: '⏺ a', style: 'dim' },
        { text: '  b▋', style: 'dim' },
      ]);

      ui.setPreview({ kind: 'text', text: 'a\nb', streaming: false });
      expect(ui.getPreviewLines()).toEqual([
        { text: '⏺ a', style: 'dim' },
        { text: '  b', style: 'dim' },
      ]);
    });

    it('多行 send-content preview：➤ 前缀、续行 2 空格、plain（无 dim）', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.setPreview({ kind: 'send-content', text: 'x\ny', streaming: true });
      expect(ui.getPreviewLines()).toEqual([
        { text: '➤ x', style: 'plain' },
        { text: '  y▋', style: 'plain' },
      ]);
    });

    it('thinking compact 模式：单行 [thinking] (...) dim', () => {
      const deps = makeDeps();
      deps.getThinkingMode.mockReturnValue('compact');
      const ui = createMainTurnUI(deps);
      ui.setPreview({ kind: 'thinking', text: 'some   long\nthinking body' });
      expect(ui.getPreviewLines()).toEqual([
        { text: '[thinking] (some long thinking body)', style: 'dim' },
      ]);
    });

    it('thinking off 模式：不显示 preview（空 lines）', () => {
      const deps = makeDeps();
      deps.getThinkingMode.mockReturnValue('off');
      const ui = createMainTurnUI(deps);
      ui.setPreview({ kind: 'thinking', text: 'hidden' });
      expect(ui.getPreviewLines()).toEqual([]);
    });

    it('clearPreview 清空 block 与 lines', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.setPreview({ kind: 'thinking', text: 't' });
      ui.clearPreview();
      expect(ui.getPreviewLines()).toEqual([]);
    });
  });

  // —— phase 1992 Step C: final flush 复用同一 renderer ——
  describe('phase 1992 Step C: final flush（与 preview 同 renderer，▋ 不进最终输出）', () => {
    it('flushThinking 单行：⏺ [thinking] 前缀 + dim color', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.appendToThinking('single thought');
      ui.flushThinking();
      expect(deps.appendOutput).toHaveBeenCalledWith('\x1b[2m', '⏺ [thinking] single thought', true, '  ');
    });

    it('flushThinking 多行：首行前缀、续行 2 空格（与 preview 视觉一致）', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.appendToThinking('line1\nline2');
      ui.flushThinking();
      expect(deps.appendOutput).toHaveBeenCalledWith(
        '\x1b[2m', '⏺ [thinking] line1\n  line2', true, '  ',
      );
    });

    it('flushStreaming 多行 text：⏺ 前缀、续行 2 空格、dim', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.appendToBuffer('a\nb');
      ui.flushStreaming();
      expect(deps.appendOutput).toHaveBeenCalledWith('\x1b[2m', '⏺ a\n  b', true, '  ');
    });

    it('flushStreamingNormal 多行 send-content：➤ 前缀、续行 2 空格、plain（无 color）', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.appendToBuffer('x\ny');
      ui.flushStreamingNormal();
      expect(deps.appendOutput).toHaveBeenCalledWith('', '➤ x\n  y', true, '  ');
    });

    it('▋ 不进入最终输出（flush 用 streaming:false 渲染）', () => {
      const deps = makeDeps();
      const ui = createMainTurnUI(deps);
      ui.appendToBuffer('final text');
      ui.setPreview({ kind: 'text', text: 'final text▋', streaming: true });
      ui.flushStreaming();
      const [, text] = (deps.appendOutput as any).mock.calls.at(-1);
      expect(text).not.toContain('▋');
      expect(text).toBe('⏺ final text');
    });

    it('trimOutputNewlines=false 时保留首尾空白', () => {
      const deps = { ...makeDeps(), trimOutputNewlines: false };
      const ui = createMainTurnUI(deps);
      ui.appendToBuffer('  padded  ');
      ui.flushStreaming();
      expect(deps.appendOutput).toHaveBeenCalledWith('\x1b[2m', '⏺   padded  ', true, '  ');
    });
  });

  // —— phase 899: 3-cycle + MIN_DWELL_MS boundary ——
  describe('phase 899: 3-cycle + MIN_DWELL_MS boundary', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('3-cycle rapid-restart 内 spinnerStartTs 非累加（反 audit sub-1 claim）', () => {
      const recordSpinner = vi.fn();
      const deps = makeDeps();
      const ui = createMainTurnUI({ ...deps, observability: { recordSpinner } });
      const T0 = Date.now();

      // cycle 1: start → 50ms → stop with dwell defer → pendingClear fires at +200
      ui.enterPhase('waiting_llm');
      vi.advanceTimersByTime(50);
      ui.enterPhase('streaming_text');
      vi.advanceTimersByTime(150);   // pendingClearTimer fires, stopSpinnerNow ran
      // 此时 spinnerStopTs ≈ T0+200, spinnerTimer = null

      // cycle 2: start at T0+205（within MIN_DWELL_MS from stop）→ continuity 分支
      vi.advanceTimersByTime(5);
      ui.enterPhase('waiting_llm');
      // continuity 触发：spinnerStartTs ≈ T0+6（virtual T0+205-199）
      vi.advanceTimersByTime(20);   // T0+225
      ui.enterPhase('streaming_text');
      // elapsed (T0+225 - T0+6) = 219 ≥ MIN_DWELL → immediate stop
      // spinnerStopTs ≈ T0+225

      // cycle 3: start at T0+230（within MIN_DWELL_MS from T0+225）→ continuity 再触发
      vi.advanceTimersByTime(5);
      ui.enterPhase('waiting_llm');
      // continuity 触发：spinnerStartTs ≈ T0+31（virtual T0+230-199）
      // 关键反证 audit sub-1：spinnerStartTs 是从 *current* now 算（T0+31）、
      // 不是 cycle 2 的 virtual T0+6 + 某偏移；virtual offset 不累加
      vi.advanceTimersByTime(20);   // T0+250
      ui.enterPhase('streaming_text');
      // elapsed (T0+250 - T0+31) = 219 ≥ MIN_DWELL → immediate stop
      // spinnerStopTs ≈ T0+250

      // 反证：3 stop 都即时（每次 elapsed 都 ~219、由 current now 算）
      const stops = recordSpinner.mock.calls.filter(c => c[0] === 'stop').length;
      expect(stops).toBe(3);   // cycle 1+2+3 全 stop（cycle 1 by pendingClearTimer，2+3 by continuity 立 stop）

      // 真新 cycle 4: 等 > MIN_DWELL_MS
      vi.advanceTimersByTime(500);   // T0+750
      ui.enterPhase('waiting_llm');
      // T0+750 - T0+250 = 500 > MIN_DWELL → fresh 分支真新 cycle
      // spinnerStartTs ≈ T0+750
      vi.advanceTimersByTime(20);   // T0+770
      ui.enterPhase('streaming_text');
      // elapsed (T0+770 - T0+750) = 20 < MIN_DWELL → schedule pendingClearTimer 180ms
      expect(recordSpinner.mock.calls.filter(c => c[0] === 'stop').length).toBe(3);   // pendingClear 未 fire
      vi.advanceTimersByTime(180);
      expect(recordSpinner.mock.calls.filter(c => c[0] === 'stop').length).toBe(4);   // cycle 4 stop after dwell
    });
  });
});
