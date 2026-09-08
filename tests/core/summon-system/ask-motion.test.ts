import { describe, it, expect } from 'vitest';
import { AskMotionTool } from '../../../src/core/summon-system/tools/ask-motion.js';
import { createDialogStore } from '../../../src/foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { LLMAuthError, LLMTimeoutError } from '../../../src/foundation/llm-provider/errors.js';
import { FileNotFoundError } from '../../../src/foundation/fs/index.js';

async function readDialogFixture(filePath: string): Promise<string> {
  if (filePath.endsWith('turn-transaction.json')) {
    throw new FileNotFoundError(filePath);
  }
  return JSON.stringify({
    version: 2, clawId: 'c1', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    systemPrompt: 'system prompt', messages: [], toolsForLLM: [],
  });
}

function makeMockFs() {
  return {
    read: readDialogFixture,
    writeAtomic: async () => {},
    ensureDir: async () => {},
    list: async () => [],
    move: async () => {},
    delete: async () => {},
    exists: async () => false,
    isDirectory: async () => false,
    stat: async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false }),
    writeAtomicSync: () => {},
    writeExclusiveSync: () => {},
    readSync: () => '',
    readBytesSync: () => Buffer.from(''),
    appendSync: () => {},
    statSync: () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false }),
    moveSync: () => {},
    existsSync: () => false,
    ensureDirSync: () => {},
    listSync: () => [],
    deleteSync: () => {},
    resolve: (p: string) => `/base/${p}`,
  } as unknown as import('../../../src/foundation/fs/types.js').FileSystem;
}
const mockAudit = { write: () => {}, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s };
const ctxStub = {} as unknown as import('../../../src/foundation/tools/index.js').ExecContext;

async function makeToolWithLLM(llm: LLMOrchestrator): Promise<AskMotionTool> {
  const mockFs = makeMockFs();
  const mockDialogStore = createDialogStore(mockFs, '/motion', mockAudit, 'current.json');
  await mockDialogStore.save({ systemPrompt: 'system prompt', messages: [], toolsForLLM: [] });
  return new AskMotionTool(llm, mockDialogStore);
}

describe('AskMotionTool', () => {
  it('should not be readonly to prevent concurrent cloneHistory mutation', async () => {
    const mockFs = {
      read: readDialogFixture,
      writeAtomic: async () => {},
      ensureDir: async () => {},
      list: async () => [],
      move: async () => {},
      delete: async () => {},
      exists: async () => false,
      isDirectory: async () => false,
      stat: async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false }),
      writeAtomicSync: () => {},
      writeExclusiveSync: () => {},
      readSync: () => '',
      readBytesSync: () => Buffer.from(''),
      appendSync: () => {},
      statSync: () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false }),
      moveSync: () => {},
      existsSync: () => false,
      ensureDirSync: () => {},
      listSync: () => [],
      deleteSync: () => {},
      resolve: (p: string) => `/base/${p}`,
    } as unknown as import('../../../src/foundation/fs/types.js').FileSystem;
    const mockAudit = { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s};
    const mockDialogStore = createDialogStore(mockFs, '/motion', mockAudit, 'current.json');
    await mockDialogStore.save({ systemPrompt: 'system prompt', messages: [], toolsForLLM: [] });
    const tool = new AskMotionTool({} as LLMOrchestrator, mockDialogStore);
    expect(tool.readonly).toBe(false);
  });

  it('consecutive executes produce strictly alternating user/assistant sequence', async () => {
    let callCount = 0;
    const llm = {
      call: async () => {
        callCount += 1;
        return {
          content: [{ type: 'text', text: `answer-${callCount}` }],
          stop_reason: 'end_turn',
        };
      },
    } as LLMOrchestrator;

    const mockFs = {
      read: readDialogFixture,
      writeAtomic: async () => {},
      ensureDir: async () => {},
      list: async () => [],
      move: async () => {},
      delete: async () => {},
      exists: async () => false,
      isDirectory: async () => false,
      stat: async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false }),
      writeAtomicSync: () => {},
      writeExclusiveSync: () => {},
      readSync: () => '',
      readBytesSync: () => Buffer.from(''),
      appendSync: () => {},
      statSync: () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false }),
      moveSync: () => {},
      existsSync: () => false,
      ensureDirSync: () => {},
      listSync: () => [],
      deleteSync: () => {},
      resolve: (p: string) => `/base/${p}`,
    } as unknown as import('../../../src/foundation/fs/types.js').FileSystem;
    const mockAudit = { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s};
    const mockDialogStore = createDialogStore(mockFs, '/motion', mockAudit, 'current.json');
    await mockDialogStore.save({ systemPrompt: 'system prompt', messages: [], toolsForLLM: [] });
    const tool = new AskMotionTool(llm, mockDialogStore);

    // phase 517 B5: ctx required (was ignored before; tests must pass minimal stub)
    const ctxStub = {} as unknown as import('../../../src/foundation/tools/index.js').ExecContext;
    await tool.execute({ question: 'q1' }, ctxStub);
    await tool.execute({ question: 'q2' }, ctxStub);

    const history = (tool as unknown as { cloneHistory: Message[] }).cloneHistory;
    const roles = history.map(m => m.role);

    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  // phase 687 (audit T1.7): catch 块按 classifyLLMError 分流；abort 重抛、其余四类标类名
  it('abort 类错误重抛、不映射为 ToolResult.success=false', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const llm = { call: async () => { throw abortErr; } } as unknown as LLMOrchestrator;
    const tool = await makeToolWithLLM(llm);
    await expect(tool.execute({ question: 'q' }, ctxStub)).rejects.toThrow('aborted');
  });

  it('permanent 类错误返 success:false + content 含 [permanent/', async () => {
    const llm = { call: async () => { throw new LLMAuthError('p', 401); } } as unknown as LLMOrchestrator;
    const tool = await makeToolWithLLM(llm);
    const result = await tool.execute({ question: 'q' }, ctxStub);
    expect(result.success).toBe(false);
    expect(result.content).toContain('[permanent/');
  });

  it('transient 类错误返 success:false + content 含 [transient/', async () => {
    const llm = { call: async () => { throw new LLMTimeoutError('p', 5000); } } as unknown as LLMOrchestrator;
    const tool = await makeToolWithLLM(llm);
    const result = await tool.execute({ question: 'q' }, ctxStub);
    expect(result.success).toBe(false);
    expect(result.content).toContain('[transient/');
  });

  // phase 1816: loadStableTurnBoundary 耗尽返回 unstable——显式失败、不发起 LLM call、
  // cloneHistory 回滚（下一次提问仍走 first-call 文案），不得把不稳定快照伪装成成功。
  it('motion 快照 unstable 时显式失败且不调用 LLM、cloneHistory 不留污染', async () => {
    const llmCalls: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const llm = {
      call: async (req: { messages: Array<{ role: string; content: unknown }> }) => {
        llmCalls.push(req);
        return { content: [{ type: 'text', text: 'answer-1' }], stop_reason: 'end_turn' };
      },
    } as unknown as LLMOrchestrator;

    // 先 unstable、后稳定的 store stub
    let unstable = true;
    const store = {
      loadStableTurnBoundary: async () => {
        if (unstable) {
          return { source: 'unstable' as const, attempts: 4, session: null };
        }
        return {
          source: 'current' as const,
          session: { systemPrompt: 'system prompt', messages: [], toolsForLLM: [] },
        };
      },
    } as unknown as ReturnType<typeof createDialogStore>;

    const tool = new AskMotionTool(llm, store);

    const failed = await tool.execute({ question: 'q1' }, ctxStub);
    expect(failed.success).toBe(false);
    expect(failed.content).toContain('未能确认稳定');
    expect(failed.content).toContain('4');
    expect(llmCalls).toEqual([]);

    // cloneHistory 已回滚：下一次成功调用的首条消息仍是 first-call 分身文案
    unstable = false;
    const ok = await tool.execute({ question: 'q2' }, ctxStub);
    expect(ok.success).toBe(true);
    expect(llmCalls.length).toBe(1);
    const firstUser = llmCalls[0].messages[0];
    expect(String(firstUser.content)).toContain('你是 Motion 的分身');
  });
});
