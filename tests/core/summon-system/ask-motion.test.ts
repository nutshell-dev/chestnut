import { describe, it, expect } from 'vitest';
import { AskMotionTool } from '../../../src/core/summon-system/tools/ask-motion.js';
import { createDialogStore } from '../../../src/foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

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
    const mockAudit = { write: () => {} };
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
    const mockAudit = { write: () => {} };
    const mockDialogStore = createDialogStore(mockFs, '/motion', mockAudit, 'current.json');
    await mockDialogStore.save({ systemPrompt: 'system prompt', messages: [], toolsForLLM: [] });
    const tool = new AskMotionTool(llm, mockDialogStore);

    await tool.execute({ question: 'q1' });
    await tool.execute({ question: 'q2' });

    const history = (tool as unknown as { cloneHistory: Message[] }).cloneHistory;
    const roles = history.map(m => m.role);

    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
