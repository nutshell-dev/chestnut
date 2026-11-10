/**
 * Phase 2094 Step B：`getContractWorkMessageId` 工作消息身份协议测试。
 *
 * 只测 owner 侧纯函数的三条边界：
 * 1. 可信身份：`from=system` + `contract_created|contract_resume` + 非空 `metadata.contract_id`
 * 2. 反向：普通用户消息带 ID 不识别；取消通知不识别；同名但非 system 不识别
 * 3. 不读 body：正文里出现 ID 不算、函数不触碰 `content`
 */
import { describe, it, expect } from 'vitest';
import { getContractWorkMessageId } from '../../../src/core/contract/work-message-reference.js';

/** 构造一条最小可信工作消息（不含 body 语义）。 */
function workMessage(overrides: {
  type?: string;
  from?: string;
  metadata?: Record<string, string>;
} = {}) {
  return {
    type: overrides.type ?? 'contract_created',
    from: overrides.from ?? 'system',
    metadata: overrides.metadata ?? { contract_id: 'contract-abc-123' },
  };
}

describe('getContractWorkMessageId: 可信工作消息身份', () => {
  it.each([
    ['contract_created', 'contract-created-1'],
    ['contract_resume', 'contract-resumed-1'],
  ])('%s + system + 非空 contract_id → 返回该 ID', (type, id) => {
    expect(getContractWorkMessageId(workMessage({ type, metadata: { contract_id: id } }))).toBe(id);
  });

  it('返回 metadata 中的原值，不做 trim（禁止改写 owner 声明的 ID）', () => {
    expect(
      getContractWorkMessageId(workMessage({ metadata: { contract_id: '  spaced-id  ' } })),
    ).toBe('  spaced-id  ');
  });

  it('可以接收完整 InboxMessage 结构（多余字段被忽略）', () => {
    const full = {
      id: 'inbox-1',
      type: 'contract_created',
      from: 'system',
      to: 'motion',
      content: 'body text',
      priority: 'high' as const,
      timestamp: '2026-11-10T00:00:00.000Z',
      metadata: { contract_id: 'c-1', other: 'x' },
    };
    expect(getContractWorkMessageId(full)).toBe('c-1');
  });
});

describe('getContractWorkMessageId: 反向边界（不误判）', () => {
  it('① 普通用户消息即使带 contract_id 也不识别为工作指令', () => {
    const result = getContractWorkMessageId(
      workMessage({ from: 'user', metadata: { contract_id: 'c-user-1' } }),
    );
    expect(result).toBeUndefined();
  });

  it('② 取消通知（contract_cancelled）不被识别为工作指令', () => {
    const result = getContractWorkMessageId(
      workMessage({ type: 'contract_cancelled', metadata: { contract_id: 'c-cancelled-1' } }),
    );
    expect(result).toBeUndefined();
  });

  it('其他系统消息类型（含 execution_recovery）不进入工作消息协议', () => {
    for (const type of ['execution_recovery', 'contract_events', 'message', 'report']) {
      expect(
        getContractWorkMessageId(workMessage({ type, metadata: { contract_id: 'c-any' } })),
      ).toBeUndefined();
    }
  });

  it('同名但非 system 来源的 contract_created 不被信任', () => {
    for (const from of ['user', 'claw', 'motion', 'claw-a1b2', 'System', '', 'system ']) {
      expect(
        getContractWorkMessageId(workMessage({ from, metadata: { contract_id: 'c-imposter' } })),
      ).toBeUndefined();
    }
  });

  it('缺失 metadata / 空字符串 / 仅空白 / 非字符串 → undefined', () => {
    const noMeta = { type: 'contract_created', from: 'system' };
    expect(getContractWorkMessageId(noMeta)).toBeUndefined();
    expect(getContractWorkMessageId(workMessage({ metadata: {} }))).toBeUndefined();
    expect(getContractWorkMessageId(workMessage({ metadata: { contract_id: '' } }))).toBeUndefined();
    expect(
      getContractWorkMessageId(
        workMessage({ metadata: { contract_id: 42 as unknown as string } }),
      ),
    ).toBeUndefined();
    expect(
      getContractWorkMessageId(
        workMessage({ metadata: { contract_id: undefined as unknown as string } }),
      ),
    ).toBeUndefined();
  });

  it('③ 历史无 ID 的消息不能从正文猜出引用（只认 metadata）', () => {
    // 正文里出现 ID、metadata 为空 → 不识别
    const legacy = {
      type: 'contract_created',
      from: 'system',
      content: 'Created contract contract_id: legacy-from-body-999 (phase onboarding)',
      metadata: {},
    };
    expect(getContractWorkMessageId(legacy)).toBeUndefined();

    // 正文与 metadata 指向不同契约时，只认 metadata（绝不从 body 抽取）
    const conflicting = {
      type: 'contract_created',
      from: 'system',
      content: 'contract_id: body-id-should-be-ignored',
      metadata: { contract_id: 'metadata-id-wins' },
    };
    expect(getContractWorkMessageId(conflicting)).toBe('metadata-id-wins');
  });

  it('③ 函数不读取 content（body getter 一旦被访问即抛错）', () => {
    const guarded = {
      type: 'contract_created',
      from: 'system',
      metadata: { contract_id: 'c-no-body-read' },
      get content(): string {
        throw new Error('getContractWorkMessageId must not read body');
      },
    };
    expect(getContractWorkMessageId(guarded)).toBe('c-no-body-read');

    // 非工作消息同样不应触碰 body
    const guardedUser = {
      type: 'contract_created',
      from: 'user',
      metadata: { contract_id: 'c-x' },
      get content(): string {
        throw new Error('getContractWorkMessageId must not read body');
      },
    };
    expect(getContractWorkMessageId(guardedUser)).toBeUndefined();
  });

  it('不读取 extraMeta 等旁路字段（只有 metadata 是协议面）', () => {
    const onlyExtra = {
      type: 'contract_created',
      from: 'system',
      extraMeta: { contract_id: 'c-in-extra' },
    };
    expect(getContractWorkMessageId(onlyExtra)).toBeUndefined();
  });

  it('纯函数：不修改入参（冻结对象可正常调用）', () => {
    const frozen = Object.freeze({
      type: 'contract_resume',
      from: 'system',
      metadata: Object.freeze({ contract_id: 'c-frozen' }),
    });
    expect(getContractWorkMessageId(frozen)).toBe('c-frozen');
    expect(frozen.metadata.contract_id).toBe('c-frozen');
  });
});
