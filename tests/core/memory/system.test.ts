import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemorySystem, createMemorySystem } from '../../../src/core/memory/system.js';

vi.mock('../../../src/core/memory/deep-dream.js', () => ({
  runDeepDream: vi.fn(async () => {}),
}));
vi.mock('../../../src/core/memory/random-dream.js', () => ({
  runRandomDream: vi.fn(async () => {}),
}));

import { runDeepDream as runDeepDreamMock } from '../../../src/core/memory/deep-dream.js';
import { runRandomDream as runRandomDreamMock } from '../../../src/core/memory/random-dream.js';

describe('MemorySystem', () => {
  const mockOpts = {
    clawforumDir: '/tmp/clawforum',
    motionDir: '/tmp/motion',
    fs: {} as any,
    motionFs: {} as any,
    audit: {} as any,
    taskSystem: {} as any,
    llmService: {} as any,
    llmConfig: { providers: [] } as any,
    maxCompressionTokens: 100,
    clawFsFactory: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createMemorySystem factory', () => {
    it('returns MemorySystem instance', () => {
      const sys = createMemorySystem(mockOpts);
      expect(sys).toBeInstanceOf(MemorySystem);
    });
  });

  describe('runDeepDream', () => {
    it('delegates to runDeepDream helper with opts forwarded', async () => {
      const sys = createMemorySystem(mockOpts);
      await sys.runDeepDream();
      expect(runDeepDreamMock).toHaveBeenCalledOnce();
      expect(runDeepDreamMock).toHaveBeenCalledWith(expect.objectContaining({
        clawforumDir: '/tmp/clawforum',
        llmConfig: mockOpts.llmConfig,
        llmService: mockOpts.llmService,
        maxCompressionTokens: 100,
        fs: mockOpts.fs,
        audit: mockOpts.audit,
        clawFsFactory: mockOpts.clawFsFactory,
      }));
    });

    it('uses override maxCompressionTokens when passed', async () => {
      const sys = createMemorySystem(mockOpts);
      await sys.runDeepDream(200);
      expect(runDeepDreamMock).toHaveBeenCalledWith(expect.objectContaining({
        maxCompressionTokens: 200,
      }));
    });

    it('falls back to opts.maxCompressionTokens when override undefined', async () => {
      const sys = createMemorySystem({ ...mockOpts, maxCompressionTokens: 50 });
      await sys.runDeepDream();
      expect(runDeepDreamMock).toHaveBeenCalledWith(expect.objectContaining({
        maxCompressionTokens: 50,
      }));
    });
  });

  describe('runRandomDream', () => {
    it('delegates to runRandomDream helper with opts forwarded', async () => {
      const sys = createMemorySystem(mockOpts);
      await sys.runRandomDream();
      expect(runRandomDreamMock).toHaveBeenCalledOnce();
      expect(runRandomDreamMock).toHaveBeenCalledWith(expect.objectContaining({
        clawforumDir: '/tmp/clawforum',
        motionDir: '/tmp/motion',
        taskSystem: mockOpts.taskSystem,
        fs: mockOpts.fs,
        motionFs: mockOpts.motionFs,
        audit: mockOpts.audit,
      }));
    });
  });
});
