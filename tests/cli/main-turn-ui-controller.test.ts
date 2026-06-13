import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMainTurnUI } from '../../src/cli/commands/chat-viewport.js';
import { MIN_DWELL_MS } from '../../src/cli/commands/main-turn-ui.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/cli/commands/viewport-audit-events.js';

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
      mainUI.setPreview('hello');
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
      mainUI.setPreview('polluted');
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
      mainUI.setPreview('a');
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
      mainUI.setPreview('system');
    });

    expect(deps.audit.write).not.toHaveBeenCalled();
  });

  it('withScope 嵌套时恢复上一 scope', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('main', () => {
      mainUI.setPreview('outer');
      expect(deps.audit.write).not.toHaveBeenCalled();

      mainUI.withScope('task', () => {
        mainUI.setPreview('inner');
        expect(deps.audit.write).toHaveBeenCalledTimes(1);
      });

      mainUI.setPreview('outer-again');
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
      mainUI.setPreview('safe');
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
    mainUI.setPreview('preview text');

    expect(mainUI.getStatus()).toMatch(/Thinking/);
    expect(mainUI.getPreview()).toBe('preview text');
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

  // —— phase 954: flushStreaming empty branch symmetric invariant ——
  it('flushStreaming with empty buffer calls deps.updateDisplay (反向: empty/non-empty branch symmetric, phase 954)', () => {
    const updateDisplaySpy = vi.fn();
    const deps = { ...makeDeps(), updateDisplay: updateDisplaySpy };
    const ui = createMainTurnUI(deps);
    updateDisplaySpy.mockClear();
    ui.flushStreaming();   // streamingBuffer empty
    expect(updateDisplaySpy).toHaveBeenCalled();
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
