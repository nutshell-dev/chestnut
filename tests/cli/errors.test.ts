import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliError, handleCliError } from '../../src/cli/errors.js';

describe('CliError', () => {
  it('stores message and code', () => {
    const err = new CliError('test msg', 42);
    expect(err.message).toBe('test msg');
    expect(err.code).toBe(42);
    expect(err.name).toBe('CliError');
  });

  it('defaults code to 1', () => {
    const err = new CliError('msg');
    expect(err.code).toBe(1);
  });

  it('is instanceof Error', () => {
    expect(new CliError('msg')).toBeInstanceOf(Error);
  });
});

describe('handleCliError', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrSpy.mockRestore();
  });

  it('CliError with code → returns code + logs message without "Error:" prefix', () => {
    const code = handleCliError(new CliError('cli-msg', 3));
    expect(code).toBe(3);
    expect(consoleErrSpy).toHaveBeenCalledWith('cli-msg');
  });

  it('CliError default code → returns 1', () => {
    const code = handleCliError(new CliError('cli-msg'));
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('cli-msg');
  });

  it('generic Error → returns 1 + logs "Error: <msg>"', () => {
    const code = handleCliError(new Error('boom'));
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('Error:', 'boom');
  });

  it('string throw → returns 1 + logs "Error: <string>"', () => {
    const code = handleCliError('plain-string');
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('Error:', 'plain-string');
  });

  it('non-Error object → returns 1 + logs "Error: <stringified>"', () => {
    const obj = { foo: 'bar' };
    const code = handleCliError(obj);
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('Error:', String(obj));
  });
});
