/**
 * AsyncTaskSystem 装配依赖冻结测试 (phase 1863 AT-D4)
 *
 * Coverage:
 * - initialize 前：三 setter 可调用（装配窗口）
 * - initialize 后：三 setter 各 throw（依赖面冻结）
 * - initialize 幂等重入：冻结语义不变
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import type { StreamLog } from '../../../src/foundation/stream/index.js';
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

  it('装配窗口（initialize 前）三 setter 可调用', () => {
    system.addPostProcessor('p-window', makeProcessor());
    system.setMainDialogStore({} as unknown as DialogStore);
    system.setParentStreamLog({ write: vi.fn() } as unknown as StreamLog);
  });

  it('initialize 后三 setter 各 throw（依赖面冻结）', async () => {
    await system.initialize();

    expect(() => system.addPostProcessor('p-late', makeProcessor())).toThrow(FROZEN_RE);
    expect(() => system.setMainDialogStore({} as unknown as DialogStore)).toThrow(FROZEN_RE);
    expect(() => system.setParentStreamLog({ write: vi.fn() } as unknown as StreamLog)).toThrow(FROZEN_RE);
  });

  it('initialize 幂等重入不改变冻结语义', async () => {
    await system.initialize();
    await system.initialize();

    expect(() => system.addPostProcessor('p-reentry', makeProcessor())).toThrow(FROZEN_RE);
  });
});
