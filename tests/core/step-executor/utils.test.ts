import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseToolInput, safeCallback } from '../../../src/core/step-executor/utils.js';

describe('parseToolInput', () => {
  it('parses valid JSON object', () => {
    const result = parseToolInput('{"key":"value","n":42}', 'tool-name');
    expect(result).toEqual({ key: 'value', n: 42 });
  });

  it('returns empty object for empty string', () => {
    const result = parseToolInput('', 'tool-name');
    expect(result).toEqual({});
  });

  it('returns __parseError marker for invalid JSON', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = parseToolInput('{ invalid', 'tool-name');
    expect(result).toMatchObject({
      __parseError: true,
      __raw: '{ invalid',
    });
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to parse tool input for "tool-name"/),
    );
    consoleErrSpy.mockRestore();
  });

  it('handles null-like raw via empty default', () => {
    const result = parseToolInput(null as unknown as string, 'tool-name');
    expect(result).toEqual({});
  });
});

describe('safeCallback', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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

  it('catches throwing Error and logs warn with label + message', () => {
    const fn = vi.fn(() => { throw new Error('boom'); });
    expect(() => safeCallback('onStep', fn)).not.toThrow();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/onStep/),
      expect.stringMatching(/boom/),
    );
  });

  it('catches non-Error throw and stringifies', () => {
    const fn = vi.fn(() => { throw 'string-err'; });
    expect(() => safeCallback('onAbort', fn)).not.toThrow();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/onAbort/),
      'string-err',
    );
  });
});
