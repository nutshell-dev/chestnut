import { describe, it, expect } from 'vitest';
import { AskMotionTool } from '../../../src/core/summon-system/tools/ask-motion.js';
import { createDialogStore } from '../../../src/foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import { LLMAuthError, LLMTimeoutError } from '../../../src/foundation/llm-provider/errors.js';

function makeMockFs() {
  return {
    read: async () => JSON.stringify({
      version: 2, clawId: 'c1', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
      systemPrompt: 'system prompt', messages: [], toolsForLLM: [],
    }),
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
      read: async () => JSON.stringify({
        version: 2, clawId: 'c1', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        systemPrompt: 'system prompt', messages: [], toolsForLLM: [],
      }),
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
      read: async () => JSON.stringify({
        version: 2, clawId: 'c1', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        systemPrompt: 'system prompt', messages: [], toolsForLLM: [],
      }),
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
});
