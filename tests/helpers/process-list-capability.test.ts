/**
 * phase 1883: process-list capability contract 分层验证
 *
 * - 探针成功 → 0 impact（不 skip、不抛）
 * - 探针抛 ProcessListUnavailable（模拟 pgrep exit 3 / ENOENT 等环境不可用）
 *   → typed skip（带原因）
 * - 探针抛非能力类错误 → 原样抛出（不吞未知错误）
 *
 * 经 DI probe + fake ctx 构造，不依赖宿主环境改造、不用 vi.mock。
 */

import { describe, it, expect, vi } from 'vitest';
import { ProcessListUnavailable } from '../../src/foundation/process-exec/index.js';
import { requireProcessListCapability } from './process-list-capability.js';

function makeCtx() {
  return { skip: vi.fn() };
}

describe('requireProcessListCapability (phase 1883)', () => {
  it('探针成功 → 不 skip 不抛（0 impact）', () => {
    const ctx = makeCtx();
    expect(() => requireProcessListCapability(ctx, () => [])).not.toThrow();
    expect(ctx.skip).not.toHaveBeenCalled();
  });

  it('探针抛 ProcessListUnavailable（pgrep exit 3 形态）→ typed skip 带原因', () => {
    const ctx = makeCtx();
    requireProcessListCapability(ctx, () => {
      throw new ProcessListUnavailable('node', new Error('pgrep exit 3'));
    });
    expect(ctx.skip).toHaveBeenCalledTimes(1);
    expect(ctx.skip.mock.calls[0]![0]).toContain('process-list capability unavailable');
    expect(ctx.skip.mock.calls[0]![0]).toContain('pgrep exit 3');
  });

  it('探针抛 ProcessListUnavailable（ENOENT 形态）→ typed skip 带原因', () => {
    const ctx = makeCtx();
    requireProcessListCapability(ctx, () => {
      throw new ProcessListUnavailable('node', new Error('spawnSync pgrep ENOENT'));
    });
    expect(ctx.skip).toHaveBeenCalledTimes(1);
    expect(ctx.skip.mock.calls[0]![0]).toContain('ENOENT');
  });

  it('探针抛非能力类错误 → 原样抛出、不 skip（不吞未知错误）', () => {
    const ctx = makeCtx();
    const boom = new Error('unexpected probe failure');
    expect(() => requireProcessListCapability(ctx, () => { throw boom; })).toThrow(boom);
    expect(ctx.skip).not.toHaveBeenCalled();
  });
});
