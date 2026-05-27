/**
 * phase 1217 (r131 C fork) B.2 — chat-viewport stream reader start fail no register
 *
 * 反向 1 项:
 * - start() throw → STREAM_READER_START_FAILED audit emit + taskWatchMap.has(taskId) === false
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEventHandler } from '../../src/cli/commands/chat-viewport-event-handler.js';
import { VIEWPORT_AUDIT_EVENTS } from '../../src/cli/commands/viewport-audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const { mockCreateStreamReader } = vi.hoisted(() => ({
  mockCreateStreamReader: vi.fn(),
}));

vi.mock('../../src/foundation/stream/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/foundation/stream/index.js')>();
  return {
    ...mod,
    createStreamReader: mockCreateStreamReader,
  };
});

describe('phase 1217 (r131 C fork) B.2 — stream reader start fail no register', () => {
  let taskWatchMap: Map<string, any>;
  let auditWrite: ReturnType<typeof vi.fn>;
  let handleEvent: ReturnType<typeof createEventHandler>;

  beforeEach(() => {
    taskWatchMap = new Map();
    auditWrite = vi.fn();
    mockCreateStreamReader.mockReset();
  });

  it('stream reader start() throw 后不注册 stale TaskWatch', () => {
    const taskId = 'task-123';
    const startError = new Error('ENOENT: stream file missing');

    // mock createStreamReader 返回一个在 start() 时 throw 的 reader
    mockCreateStreamReader.mockReturnValue({
      start: () => { throw startError; },
    } as any);

    handleEvent = createEventHandler({
      turnTracker: { begin: vi.fn() } as any,
      mainUI: {
        flushThinking: vi.fn(),
        flushStreaming: vi.fn(),
        enterPhase: vi.fn(),
        clearPreview: vi.fn(),
        appendToThinking: vi.fn(),
        flushThinkingToOutput: vi.fn(),
        appendOutput: vi.fn(),
        withScope: vi.fn(),
      } as any,
      appendOutput: vi.fn(),
      showSystemMessages: false,
      showContractEvents: false,
      fsFactory,
      agentDir: '/tmp/agent',
      label: 'test',
      audit: { write: auditWrite } as any,
      observability: { recordEvent: vi.fn(), recordRenderBatch: vi.fn() } as any,
      taskWatchMap,
      handleTaskEvent: vi.fn(),
      taskStatusBar: { addTrack: vi.fn() },
      getThinkingMode: () => 'off' as const,
    });

    handleEvent({
      type: 'task_started',
      taskId,
      callerType: 'subagent',
    });

    // audit 应记录 STREAM_READER_START_FAILED
    expect(auditWrite).toHaveBeenCalledWith(
      VIEWPORT_AUDIT_EVENTS.STREAM_READER_START_FAILED,
      expect.stringContaining(`taskId=${taskId}`),
      expect.stringContaining(startError.message),
    );

    // taskWatchMap 不应有该 taskId（不 register stale TaskWatch）
    expect(taskWatchMap.has(taskId)).toBe(false);
  });
});
