import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemorySystem, createMemorySystem } from '../../../src/core/memory/system.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';

describe('MemorySystem', () => {
  const mockTopology = {
    enumerate: vi.fn(() => []),
    resolve: vi.fn(() => ({ kind: 'local', clawDir: '/tmp/chestnut/claws/test' })),
    read: vi.fn(async () => ''),
    readJSON: vi.fn(async () => ({} as any)),
  } as unknown as ClawTopology;

  const mockOpts = {
    clawsDir: '/tmp/chestnut/claws',
    clawTopology: mockTopology,
    motionDir: '/tmp/motion',
    fs: {} as any,
    motionFs: {} as any,
    audit: {} as any,
    taskSystem: {} as any,
    llmService: {} as any,
    llmConfig: { providers: [] } as any,
    maxCompressionTokens: 100,
    clawFsFactory: vi.fn(),
    notifyMotion: vi.fn(),
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
      const runDeepDream = vi.fn(async () => {});
      const sys = createMemorySystem({ ...mockOpts, runDeepDream });
      await sys.runDeepDream();
      expect(runDeepDream).toHaveBeenCalledOnce();
      expect(runDeepDream).toHaveBeenCalledWith(expect.objectContaining({
        clawTopology: mockTopology,
        llmConfig: mockOpts.llmConfig,
        llmService: mockOpts.llmService,
        maxCompressionTokens: 100,
        fs: mockOpts.fs,
        audit: mockOpts.audit,
        clawFsFactory: mockOpts.clawFsFactory,
      }));
    });

    it('uses override maxCompressionTokens when passed', async () => {
      const runDeepDream = vi.fn(async () => {});
      const sys = createMemorySystem({ ...mockOpts, runDeepDream });
      await sys.runDeepDream(200);
      expect(runDeepDream).toHaveBeenCalledWith(expect.objectContaining({
        maxCompressionTokens: 200,
      }));
    });

    it('falls back to opts.maxCompressionTokens when override undefined', async () => {
      const runDeepDream = vi.fn(async () => {});
      const sys = createMemorySystem({ ...mockOpts, maxCompressionTokens: 50, runDeepDream });
      await sys.runDeepDream();
      expect(runDeepDream).toHaveBeenCalledWith(expect.objectContaining({
        maxCompressionTokens: 50,
      }));
    });
  });

  describe('runRandomDream', () => {
    it('delegates to runRandomDream helper with opts forwarded', async () => {
      const runRandomDream = vi.fn(async () => {});
      const sys = createMemorySystem({ ...mockOpts, runRandomDream });
      await sys.runRandomDream();
      expect(runRandomDream).toHaveBeenCalledOnce();
      expect(runRandomDream).toHaveBeenCalledWith(expect.objectContaining({
        motionDir: '/tmp/motion',
        taskSystem: mockOpts.taskSystem,
        fs: mockOpts.fs,
        motionFs: mockOpts.motionFs,
        audit: mockOpts.audit,
        notifyMotion: mockOpts.notifyMotion,
      }));
    });
  });
});
