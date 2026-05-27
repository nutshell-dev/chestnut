import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('DialogStore phase 988: corruptedPoisoned reset on save + archive (data loss prevention)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let store: DialogStore;
  const filename = 'current.json';
  const clawId = 'test-claw';

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    store = new DialogStore(fs, '', audit.audit, filename, clawId);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('save() resets corruptedPoisoned after successful writeAtomic (G.1 data loss prevention)', async () => {
    // setUp: simulate poisoned state (would result from line 85 corruption-isolate-fail)
    (store as any).corruptedPoisoned = true;

    // save 新内容
    const snapshot = {
      systemPrompt: 'test prompt',
      messages: [{ role: 'user' as const, content: 'test msg' }],
      toolsForLLM: [],
    };
    await store.save(snapshot);

    // 反向：corruptedPoisoned 已 reset
    expect((store as any).corruptedPoisoned).toBe(false);

    // 反向：next load() 读 current.json 不跳到 archive
    const result = await store.load();
    expect(result.source).toBe('current');
    expect(result.session.systemPrompt).toBe('test prompt');
    expect(result.session.messages).toHaveLength(1);
    expect(result.session.messages[0].content).toBe('test msg');
  });

  it('archive() resets corruptedPoisoned after successful move (G.2 fresh cold-start)', async () => {
    // setUp: 先 save 一次让 current.json 存在
    await store.save({
      systemPrompt: 'pre-archive',
      messages: [],
      toolsForLLM: [],
    });

    // setUp: simulate poisoned state
    (store as any).corruptedPoisoned = true;

    // archive
    await store.archive();

    // 反向：corruptedPoisoned 已 reset
    expect((store as any).corruptedPoisoned).toBe(false);

    // 反向：next load() cold-start（current.json 不存在、archive 1 entry pre-archive content）
    // archive() 后 next load 仍走 archive recovery path（current.json 已 move 走、是正确行为）
    // 但 corruptedPoisoned reset 后下次 save → load 周期可走 current 路径
    await store.save({
      systemPrompt: 'post-archive',
      messages: [],
      toolsForLLM: [],
    });
    const result = await store.load();
    expect(result.source).toBe('current');
    expect(result.session.systemPrompt).toBe('post-archive');
  });
});
