/**
 * Phase 1793: resolvePreset 未知 preset typed error（unknown-preset-generic-error 治理）。
 *
 * - 未知 id 抛 LLMProvider-owned `UnknownPresetError`（instanceof 可机械区分用户配置错误）。
 * - 字段保留原始 presetId 与不可变 availablePresetIds（PRESETS 单源派生，caller 不重算）。
 * - message 与旧普通 Error 字节兼容（Object.keys 顺序不变）。
 */

import { describe, it, expect } from 'vitest';
import { PRESETS, resolvePreset, UnknownPresetError } from '../../src/foundation/llm-provider/presets.js';

function catchUnknown(id: string): UnknownPresetError {
  try {
    resolvePreset(id);
  } catch (e) {
    expect(e).toBeInstanceOf(UnknownPresetError);
    return e as UnknownPresetError;
  }
  throw new Error('unreachable: resolvePreset did not throw');
}

describe('UnknownPresetError (phase 1793)', () => {
  it('未知 id 抛 UnknownPresetError（instanceof Error 且 name 正确）', () => {
    const err = catchUnknown('nonexistent-provider');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UnknownPresetError');
  });

  it('保留原始 presetId（不经字符串反解析）', () => {
    expect(catchUnknown('nonexistent-provider').presetId).toBe('nonexistent-provider');
    expect(catchUnknown('').presetId).toBe('');
    expect(catchUnknown('Anthropic').presetId).toBe('Anthropic');  // 大小写敏感原样保留
  });

  it('availablePresetIds 由 PRESETS 单源派生且不可变', () => {
    const err = catchUnknown('nope');
    expect([...err.availablePresetIds]).toEqual(Object.keys(PRESETS));
    expect(Object.isFrozen(err.availablePresetIds)).toBe(true);
    // 两次抛错的实例互不共享可变成分（防御性拷贝）
    const a = catchUnknown('nope');
    const b = catchUnknown('nope');
    expect(a.availablePresetIds).not.toBe(b.availablePresetIds);
  });

  it('message 与旧普通 Error 字节兼容（id + available list）', () => {
    const expected = `Unknown provider preset "nonexistent-provider". Available presets: ${Object.keys(PRESETS).join(', ')}`;
    expect(catchUnknown('nonexistent-provider').message).toBe(expected);
  });

  it('已知 preset 行为不变（不抛错、返回同一 catalog 条目）', () => {
    expect(resolvePreset('anthropic')).toBe(PRESETS['anthropic']);
    expect(resolvePreset('custom-gemini').apiFormat).toBe('gemini');
  });
});
