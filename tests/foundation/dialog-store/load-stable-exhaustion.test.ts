import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import type { StableLoadResult } from '../../../src/foundation/dialog-store/types.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

/**
 * phase 1816 (load-stable-exhaustion-downgrades):
 * loadStable / loadStableTurnBoundary mtime 一致性重试耗尽时必须返回显式
 * unstable 分支（attempts 证据 + session null），不再退回普通 load() 伪装成功。
 */

/** stat 每次返回递增 mtime —— 一致性检查永远不满足 → 必然耗尽 */
class UnstableStatFs extends NodeFileSystem {
  private tick = 0;
  override async stat(path: string) {
    const s = await super.stat(path);
    this.tick += 1;
    return { ...s, mtime: new Date(s.mtime.getTime() + this.tick * 60_000) };
  }
}

/** StableLoadResult 穷尽 reducer——新增变体未处理时此处编译错误（never 检查） */
function summarize(result: StableLoadResult): string {
  switch (result.source) {
    case 'current':
    case 'archive':
    case 'empty':
      return `loaded:${result.session.messages.length}`;
    case 'io_error':
      return `io_error:${result.error}`;
    case 'unstable':
      return `unstable:${result.attempts}`;
    default: {
      const _exhaustive: never = result;
      throw new Error(`unreachable: ${String(_exhaustive)}`);
    }
  }
}

describe('phase 1816 loadStable 重试耗尽治理', () => {
  let tempDir: string;
  let stableFs: NodeFileSystem;
  const filename = 'current.json';
  const clawId = 'test-claw';

  const snapshot = {
    systemPrompt: 'sys',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
    toolsForLLM: [],
  };

  beforeEach(async () => {
    tempDir = await createTempDir('chestnut-test-');
    stableFs = new NodeFileSystem({ baseDir: tempDir });
    // 先落一份合法 current.json，让耗尽路径走「stat 不一致」而非 cold-start
    await new DialogStore(stableFs, '', makeAudit().audit, filename, clawId).save(snapshot);
  });
  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('耗尽返回 unstable（attempts 证据 + session null）且不调用兜底 load', async () => {
    const { audit, events } = makeAudit();
    const store = new DialogStore(new UnstableStatFs({ baseDir: tempDir }), '', audit, filename, clawId);
    const loadSpy = vi.spyOn(store, 'load');

    const maxRetries = 1;
    const result = await store.loadStable(maxRetries);

    expect(result).toEqual({ source: 'unstable', attempts: maxRetries + 1, session: null });
    // 每次 attempt 恰好调用一次 load，耗尽后不再多调一次兜底 load()
    expect(loadSpy).toHaveBeenCalledTimes(maxRetries + 1);
    // 既有 CORRUPTED audit 证据保留，且恰好一条
    const corrupted = events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.CORRUPTED);
    expect(corrupted).toEqual([
      [DIALOG_AUDIT_EVENTS.CORRUPTED, 'file=current.json', `reason=load_stable_exhausted_after_${maxRetries}_retries`],
    ]);
  });

  it('loadStableTurnBoundary 耗尽直通 unstable，不进入截断逻辑', async () => {
    const { audit, events } = makeAudit();
    const store = new DialogStore(new UnstableStatFs({ baseDir: tempDir }), '', audit, filename, clawId);

    const result = await store.loadStableTurnBoundary(1);

    expect(result.source).toBe('unstable');
    if (result.source === 'unstable') {
      expect(result.attempts).toBe(2);
      expect(result.session).toBeNull();
    }
    expect(events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_BOUNDARY_TRUNCATED)).toEqual([]);
  });

  it('stat 一致时正常返回 current（稳定路径回归）', async () => {
    const store = new DialogStore(stableFs, '', makeAudit().audit, filename, clawId);
    const result = await store.loadStable();
    expect(result.source).toBe('current');
    if (result.source === 'current') {
      expect(result.session.messages.length).toBe(1);
    }
  });

  it('StableLoadResult 穷尽 switch 覆盖全部变体（unstable 携带 attempts）', () => {
    expect(summarize({ source: 'unstable', attempts: 4, session: null })).toBe('unstable:4');
    expect(summarize({ source: 'io_error', error: 'EIO', session: null })).toBe('io_error:EIO');
  });
});
