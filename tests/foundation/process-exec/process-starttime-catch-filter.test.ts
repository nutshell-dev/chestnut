import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track mock state so each test can configure execFileSync behaviour.
let mockThrow: Error | null = null;

vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>();
  return {
    ...mod,
    execFileSync: vi.fn((...args: any[]) => {
      if (mockThrow) {
        throw mockThrow;
      }
      return mod.execFileSync(...args);
    }),
  };
});

// Import the SUT *after* the mock is declared.
import { getProcessStartTime } from '../../../src/foundation/process-exec/process-starttime.js';

describe('getProcessStartTime catch filter', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockThrow = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockThrow = null;
  });

  it('gone PID: returns undefined and does NOT log to stderr', () => {
    const result = getProcessStartTime(99_999_999);
    expect(result).toBeUndefined();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('self PID: returns string', () => {
    const result = getProcessStartTime(process.pid);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('unexpected ps exit status returns undefined silently', () => {
    mockThrow = Object.assign(new Error('Command failed: ps -p 1 -o lstart='), {
      status: 2,
      code: undefined,
      signal: null,
    });

    const result = getProcessStartTime(1);
    expect(result).toBeUndefined();
    // Business-path console logging removed per Phase1179; silent path is acceptable
    expect(errSpy).not.toHaveBeenCalled();
  });
});
