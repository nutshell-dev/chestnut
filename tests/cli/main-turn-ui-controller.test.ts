import { describe, it, expect, vi } from 'vitest';
import { createMainTurnUI } from '../../src/cli/commands/chat-viewport.js';
import { AUDIT_EVENTS } from '../../src/foundation/audit/events.js';

describe('MainTurnUIController', () => {
  const makeDeps = () => ({
    appendOutput: vi.fn(),
    updateDisplay: vi.fn(),
    trimOutputNewlines: true,
    getThinkingMode: vi.fn(() => 'full' as const),
    audit: { write: vi.fn() },
  });

  it('正常 main scope 下写操作不触发 audit', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('main', () => {
      mainUI.setSuffix('hello');
      mainUI.startSpinner();
      mainUI.appendToBuffer('world');
    });

    expect(deps.audit.write).not.toHaveBeenCalled();
    expect(deps.updateDisplay).toHaveBeenCalled();
  });

  it('task scope 下写主 UI 触发 viewport_ui_cross_pollution audit', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('task', () => {
      mainUI.setSuffix('polluted');
    });

    expect(deps.audit.write).toHaveBeenCalledTimes(1);
    expect(deps.audit.write).toHaveBeenCalledWith(
      AUDIT_EVENTS.VIEWPORT_UI_CROSS_POLLUTION,
      'setSuffix',
      'task',
    );
  });

  it('task scope 下多个写操作各自触发 audit', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('task', () => {
      mainUI.setSuffix('a');
      mainUI.clearSuffix();
      mainUI.startSpinner();
      mainUI.stopSpinner();
      mainUI.appendToBuffer('b');
      mainUI.flushStreaming();
      mainUI.appendToThinking('c');
      mainUI.flushThinking();
    });

    // startSpinner 内部调用 stopSpinner + setSuffix，所以实际触发次数 > 8
    expect(deps.audit.write.mock.calls.length).toBeGreaterThanOrEqual(8);
    // 验证关键方法都被 audit 了
    const methods = deps.audit.write.mock.calls.map((c: any[]) => c[1]);
    expect(methods).toContain('setSuffix');
    expect(methods).toContain('clearSuffix');
    expect(methods).toContain('startSpinner');
    expect(methods).toContain('stopSpinner');
    expect(methods).toContain('appendToBuffer');
    expect(methods).toContain('flushStreaming');
    expect(methods).toContain('appendToThinking');
    expect(methods).toContain('flushThinking');
  });

  it('system scope 下写操作不触发 audit', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('system', () => {
      mainUI.setSuffix('system');
    });

    expect(deps.audit.write).not.toHaveBeenCalled();
  });

  it('withScope 嵌套时恢复上一 scope', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    mainUI.withScope('main', () => {
      mainUI.setSuffix('outer');
      expect(deps.audit.write).not.toHaveBeenCalled();

      mainUI.withScope('task', () => {
        mainUI.setSuffix('inner');
        expect(deps.audit.write).toHaveBeenCalledTimes(1);
      });

      // 恢复 main scope
      mainUI.setSuffix('outer-again');
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

    // 异常后 scope 应恢复，后续 main scope 操作不触发 audit
    mainUI.withScope('main', () => {
      mainUI.setSuffix('safe');
    });
    expect(deps.audit.write).not.toHaveBeenCalled();
  });

  it('appendToBuffer 返回更新后的 buffer', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    const buf1 = mainUI.appendToBuffer('hello');
    expect(buf1).toBe('hello');

    const buf2 = mainUI.appendToBuffer(' world');
    expect(buf2).toBe('hello world');
  });

  it('appendToThinking 返回更新后的 buffer', () => {
    const deps = makeDeps();
    const mainUI = createMainTurnUI(deps);

    const buf1 = mainUI.appendToThinking('think');
    expect(buf1).toBe('think');

    const buf2 = mainUI.appendToThinking('ing');
    expect(buf2).toBe('thinking');
  });
});
