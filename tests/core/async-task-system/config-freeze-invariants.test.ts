/**
 * AsyncTaskSystem 装配依赖冻结测试 (phase 1863 AT-D4)
 *
 * Coverage:
 * - initialize 前：可变面（addPostProcessor）可调用（装配窗口）
 * - initialize 后：可变面各 throw（依赖面冻结）
 * - initialize 幂等重入：冻结语义不变
 *
 * phase 1872 Step F：setParentStreamLog 退役（parentStreamLog 改 options 构造
 * 参数一次固定）——冻结面探针收敛为 addPostProcessor。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PostProcessor } from '../../../src/core/async-task-system/post-processors/types.js';
import { createTestTaskSystem } from '../../helpers/task-system.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';

const FROZEN_RE = /frozen after initialize \(phase 1863 AT-D4\)/;

describe('AsyncTaskSystem dependency freeze (phase 1863 AT-D4)', () => {
  let tempDir: string;
  let system: ReturnType<typeof createTestTaskSystem>;

  const makeProcessor = () =>
    vi.fn().mockResolvedValue({ schema_version: 1, content: 'x', isError: false }) as unknown as PostProcessor;

  beforeEach(async () => {
    tempDir = await createTempDir();
    const fs = new NodeFileSystem({ baseDir: tempDir });
    const audit = makeAudit();
    system = createTestTaskSystem(tempDir, fs, audit.audit);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('装配窗口（initialize 前）可变面可调用', () => {
    // phase 1863 (AT-D5)：setMainDialogStore 随 dead pass-through 删除（装配面收窄）
    // phase 1872 Step F：setParentStreamLog 退役（唯一余留 post-ctor 可变面 = postProcessor）。
    system.addPostProcessor('p-window', makeProcessor());
  });

  it('initialize 后可变面各 throw（依赖面冻结）', async () => {
    await system.initialize();

    expect(() => system.addPostProcessor('p-late', makeProcessor())).toThrow(FROZEN_RE);
  });

  it('initialize 幂等重入不改变冻结语义', async () => {
    await system.initialize();
    await system.initialize();

    expect(() => system.addPostProcessor('p-reentry', makeProcessor())).toThrow(FROZEN_RE);
  });
});
