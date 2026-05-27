import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseToolInput, safeCallback } from '../../../src/core/step-executor/utils.js';

describe('parseToolInput', () => {
  it('parses valid JSON object', () => {
    const result = parseToolInput('{"key":"value","n":42}', 'tool-name');
    expect(result).toEqual({ ok: true, data: { key: 'value', n: 42 } });
  });

  it('returns empty object for empty string', () => {
    const result = parseToolInput('', 'tool-name');
    expect(result).toEqual({ ok: true, data: {} });
  });

  it('returns typed error for invalid JSON', () => {
    const result = parseToolInput('{ invalid', 'tool-name');
    expect(result).toEqual({
      ok: false,
      raw: '{ invalid',
      error: expect.any(String),
    });
  });

  it('handles null-like raw via empty default', () => {
    const result = parseToolInput(null as unknown as string, 'tool-name');
    expect(result).toEqual({ ok: true, data: {} });
  });
});

describe('safeCallback', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('executes callback normally without warn', () => {
    const fn = vi.fn();
    safeCallback('onTurnStart', fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('catches throwing Error without warn and without breaking execution', () => {
    const fn = vi.fn(() => { throw new Error('boom'); });
    expect(() => safeCallback('onStep', fn)).not.toThrow();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('catches non-Error throw without warn and without breaking execution', () => {
    const fn = vi.fn(() => { throw 'string-err'; });
    expect(() => safeCallback('onAbort', fn)).not.toThrow();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('emits onSafeCallbackError when callback throws and callbacks provided', () => {
    const fn = vi.fn(() => { throw new Error('boom'); });
    const onSafeCallbackError = vi.fn();
    expect(() => safeCallback('onStep', fn, { onSafeCallbackError })).not.toThrow();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(onSafeCallbackError).toHaveBeenCalledOnce();
    expect(onSafeCallbackError).toHaveBeenCalledWith('onStep', expect.any(Error));
    expect((onSafeCallbackError.mock.calls[0]![1] as Error).message).toBe('boom');
  });

  it('does not emit onSafeCallbackError when callbacks omitted', () => {
    const fn = vi.fn(() => { throw new Error('boom'); });
    expect(() => safeCallback('onStep', fn)).not.toThrow();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('does not emit onSafeCallbackError when callback succeeds', () => {
    const fn = vi.fn();
    const onSafeCallbackError = vi.fn();
    safeCallback('onStep', fn, { onSafeCallbackError });
    expect(onSafeCallbackError).not.toHaveBeenCalled();
  });
});
