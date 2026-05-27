import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withCliErrorHandling } from '../../src/cli/with-cli-error-handling.js';
import { CliError } from '../../src/cli/errors.js';

describe('withCliErrorHandling', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('happy path: action resolves without calling process.exit', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const wrapped = withCliErrorHandling(action);
    await wrapped('arg1', 'arg2');
    expect(action).toHaveBeenCalledWith('arg1', 'arg2');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('CliError thrown → process.exit called with CliError code + console.error once', async () => {
    const action = vi.fn().mockRejectedValue(new CliError('bad args', 2));
    const wrapped = withCliErrorHandling(action);
    await expect(wrapped()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('bad args');
  });

  it('generic Error thrown → process.exit called with 1 + console.error once', async () => {
    const action = vi.fn().mockRejectedValue(new Error('boom'));
    const wrapped = withCliErrorHandling(action);
    await expect(wrapped()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('Error:', 'boom');
  });

  it('string thrown → process.exit called with 1 + console.error once', async () => {
    const action = vi.fn().mockRejectedValue('plain-string');
    const wrapped = withCliErrorHandling(action);
    await expect(wrapped()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrSpy).toHaveBeenCalledTimes(1);
  });
});
