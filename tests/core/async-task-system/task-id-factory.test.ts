/**
 * phase 1863 (AT-D11)：TaskId factory 运行时验证 + 构造/反序列化入口分离。
 *
 * Coverage:
 * - 构造入口（严）：非法字符串拒绝（makeFullTaskId/makeShortTaskId/makeTaskId）
 * - 反序列化入口（宽容）：非法值不抛、onInvalid 记录、返回 undefined
 * - 读路径 tolerant：taskShortId / deriveShortIdFromTaskId 对 legacy 值原语义保持
 */
import { describe, it, expect, vi } from 'vitest';
import {
  makeFullTaskId,
  makeShortTaskId,
  makeTaskId,
  readFullTaskId,
  readShortTaskId,
  deriveShortIdFromTaskId,
  taskShortId,
  type TaskId,
} from '../../../src/core/async-task-system/types.js';

describe('TaskId factory runtime validation (phase 1863 AT-D11)', () => {
  it('构造入口（严）：合法 UUID / 8-hex 通过', () => {
    const full = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    expect(full).toBe('550e8400-e29b-41d4-a716-446655440000');
    const short = makeShortTaskId('550e8400');
    expect(short).toBe('550e8400');
    expect(makeTaskId('550e8400')).toBe('550e8400');
    expect(makeTaskId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('构造入口（严）：非法字符串拒绝（不再 unchecked cast）', () => {
    for (const bad of ['tk_abc', 'task-1', 'overflow-task', '', '550e840', '550e8400-e29b-41d4-a716-44665544000g']) {
      expect(() => makeFullTaskId(bad)).toThrow(/invalid FullTaskId/);
      expect(() => makeShortTaskId(bad)).toThrow(/invalid ShortTaskId/);
      expect(() => makeTaskId(bad)).toThrow(/invalid TaskId/);
    }
    // 36 字符但非 UUID 结构
    expect(() => makeFullTaskId('x'.repeat(36))).toThrow(/invalid FullTaskId/);
  });

  it('反序列化入口（宽容）：非法值不抛、onInvalid 记录、返回 undefined', () => {
    const onFull = vi.fn();
    const onShort = vi.fn();
    expect(readFullTaskId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(readFullTaskId('legacy-task-id', onFull)).toBeUndefined();
    expect(onFull).toHaveBeenCalledWith('legacy-task-id');
    expect(readShortTaskId('550e8400')).toBe('550e8400');
    expect(readShortTaskId('task-x', onShort)).toBeUndefined();
    expect(onShort).toHaveBeenCalledWith('task-x');
  });

  it('读路径 tolerant：legacy/历史值原语义保持（不拒绝、不丢）', () => {
    // deriveShortIdFromTaskId：非 36 字符按其原值（历史 8-hex / fixture）
    expect(deriveShortIdFromTaskId('550e8400' as TaskId)).toBe('550e8400');
    expect(deriveShortIdFromTaskId('task-x' as TaskId)).toBe('task-x');
    // taskShortId：持久化 shortId 为历史值时原样保留
    expect(taskShortId({ id: '550e8400-e29b-41d4-a716-446655440000' as TaskId, shortId: '550e8400' })).toBe('550e8400');
    expect(taskShortId({ id: '550e8400-e29b-41d4-a716-446655440000' as TaskId, shortId: 'legacy-short' })).toBe('legacy-short');
    // 无 shortId → 由 id 派生
    expect(taskShortId({ id: '550e8400-e29b-41d4-a716-446655440000' as TaskId })).toBe('550e8400');
  });
});
