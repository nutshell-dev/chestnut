/**
 * Phase 1260: ContractNotification transport adapter 行为测试。
 * （Step B：adapter 物理归位 src/assembly/contract-notification-adapter.ts）
 *
 * 锁死 legacy transport shape（stream system_notify payload + completed/cancelled
 * self-inbox）：typed event 经 exhaustive mapper 恢复历史 camel/snake 混排输出，
 * 逐字段（含 key 集合与 body 文本）保持现状，不归一化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { createContractNotificationAdapter } from '../../src/assembly/contract-notification-adapter.js';
import type { ContractNotification } from '../../src/core/contract/index.js';
import { makeContractId, makeSubtaskId } from '../../src/core/contract/types.js';
import type { StreamWriter } from '../../src/foundation/stream/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeMockAudit } from '../helpers/audit.js';

const CLAW_ID = 'test-claw';

describe('phase 1260: contract notification adapter legacy transport shape', () => {
  let tempDir: string;
  let selfInboxDir: string;
  let streamWrite: ReturnType<typeof vi.fn>;
  let emit: (event: ContractNotification) => void;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('phase1260-notify-');
    selfInboxDir = path.join(tempDir, 'inbox', 'pending');
    fs.mkdirSync(selfInboxDir, { recursive: true });
    streamWrite = vi.fn();
    emit = createContractNotificationAdapter({
      streamWriter: { write: streamWrite } as unknown as StreamWriter,
      clawId: CLAW_ID,
      systemFs: new NodeFileSystem({ baseDir: tempDir }),
      selfInboxDir,
      auditWriter: makeMockAudit(),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function inboxFiles(): string[] {
    return fs.readdirSync(selfInboxDir);
  }

  function readOnlyInboxFile(): string {
    const files = inboxFiles();
    expect(files).toHaveLength(1);
    return fs.readFileSync(path.join(selfInboxDir, files[0]), 'utf8');
  }

  it('contract_created → stream camel payload / 无 inbox', () => {
    emit({
      type: 'contract_created',
      contractId: makeContractId('c1'),
      title: 'T',
      subtaskCount: 2,
    });

    expect(streamWrite).toHaveBeenCalledTimes(1);
    expect(streamWrite).toHaveBeenCalledWith({
      ts: expect.any(Number),
      type: 'system_notify',
      subtype: 'contract_created',
      contractId: 'c1',
      title: 'T',
      subtaskCount: 2,
    });
    expect(inboxFiles()).toHaveLength(0);
  });

  it('contract_completed → stream mixed payload 不变 + contract_events self-inbox（phase 1832 新正文语义）', () => {
    emit({
      type: 'contract_completed',
      contractId: makeContractId('c1'),
      title: 'T',
      goal: 'G',
      subtasks: [
        { id: makeSubtaskId('t1'), completedAt: '2026-08-01T00:00:00Z', forceAccepted: false },
        { id: makeSubtaskId('t2'), completedAt: '2026-08-01T01:00:00Z', forceAccepted: true },
      ],
      completedAt: '2026-08-01T01:00:00Z',
    });

    // stream system_notify payload 逐字段保持 legacy shape（phase 1832 不动 stream 协议）
    expect(streamWrite).toHaveBeenCalledTimes(1);
    expect(streamWrite).toHaveBeenCalledWith({
      ts: expect.any(Number),
      type: 'system_notify',
      subtype: 'contract_completed',
      contractId: 'c1',
      title: 'T',
      goal: 'G',
      subtasks: [
        { id: 't1', completed_at: '2026-08-01T00:00:00Z', force_accepted: false },
        { id: 't2', completed_at: '2026-08-01T01:00:00Z', force_accepted: true },
      ],
      completed_at: '2026-08-01T01:00:00Z',
    });

    const content = readOnlyInboxFile();
    expect(content).toContain('type: contract_events');
    expect(content).toContain('priority: high');
    // phase 1261 Step B: v1 exact wire（guidance_schema_version + contract_refs JSON），无 legacy keys
    expect(content).toContain('guidance_schema_version: 1');
    expect(content).toContain(
      'contract_refs: "[{\\"claw_id\\":\\"test-claw\\",\\"contract_id\\":\\"c1\\"}]"',
    );
    expect(content).not.toContain('source_claw:');
    expect(content).not.toMatch(/^contract_id:/m);
    // phase 1832: 正文自足呈现终态/对象/执行者/原目标/完成时间/逐子任务；
    // forceAccepted 仅中性放行注记，不表示验收通过；缺省不反推质量通过。
    expect(content).toContain(
      '契约流程已完成｜T（c1）\n'
      + '执行者：test-claw\n'
      + '原目标：G\n'
      + '完成时间：2026-08-01T01:00:00Z\n'
      + '已完成子任务：\n'
      + '  [t1] 完成时间：2026-08-01T00:00:00Z\n'
      + '  [t2] 完成时间：2026-08-01T01:00:00Z\n'
      + '    完成方式：按流程放行记为完成；该标记不表示验收通过',
    );
    // 不再携带 legacy 序列化串
    expect(content).not.toContain('[contract_completed]');
    expect(content).not.toContain('subtasks=[');
  });

  it('contract_completed（空标题/空目标）→ 只显 ID，不省略已存在的时间', () => {
    emit({
      type: 'contract_completed',
      contractId: makeContractId('c2'),
      title: '',
      goal: '',
      subtasks: [
        { id: makeSubtaskId('t1'), completedAt: '2026-08-02T00:00:00Z', forceAccepted: false },
      ],
      completedAt: '2026-08-02T00:00:00Z',
    });

    const content = readOnlyInboxFile();
    expect(content).toContain(
      '契约流程已完成｜c2\n'
      + '执行者：test-claw\n'
      + '完成时间：2026-08-02T00:00:00Z\n'
      + '已完成子任务：\n'
      + '  [t1] 完成时间：2026-08-02T00:00:00Z',
    );
    expect(content).not.toContain('原目标：');
    expect(content).not.toContain('（）');
  });

  it('contract_cancelled → stream camel payload + contract_cancelled self-inbox（v1 guidance wire、reason 仅留 body/stream）', () => {
    emit({
      type: 'contract_cancelled',
      contractId: makeContractId('c1'),
      reason: 'user cancelled',
    });

    // stream system_notify payload 保持（含 reason）
    expect(streamWrite).toHaveBeenCalledTimes(1);
    expect(streamWrite).toHaveBeenCalledWith({
      ts: expect.any(Number),
      type: 'system_notify',
      subtype: 'contract_cancelled',
      contractId: 'c1',
      reason: 'user cancelled',
    });

    const content = readOnlyInboxFile();
    expect(content).toContain('type: contract_cancelled');
    expect(content).toContain('priority: high');
    // phase 1262 Step B: v1 exact wire（guidance_schema_version + cancelled_contract_refs JSON），无 legacy keys
    expect(content).toContain('guidance_schema_version: 1');
    expect(content).toContain(
      'cancelled_contract_refs: "[{\\"claw_id\\":\\"test-claw\\",\\"contract_id\\":\\"c1\\"}]"',
    );
    expect(content).not.toContain('source_claw:');
    expect(content).not.toMatch(/^contract_id:/m);
    expect(content).not.toMatch(/^reason:/m);
    // body 仍持久化 reason（不随 metadata 删除）
    expect(content).toContain(
      '[contract_cancelled] claw=test-claw contractId=c1 reason=user cancelled',
    );
  });

  it('subtask_completed（普通路径）→ stream camel payload / 无 inbox', () => {
    emit({
      type: 'subtask_completed',
      contractId: makeContractId('c1'),
      subtaskId: makeSubtaskId('t1'),
    });

    expect(streamWrite).toHaveBeenCalledTimes(1);
    expect(streamWrite).toHaveBeenCalledWith({
      ts: expect.any(Number),
      type: 'system_notify',
      subtype: 'subtask_completed',
      contractId: 'c1',
      subtaskId: 't1',
    });
    expect(inboxFiles()).toHaveLength(0);
  });

  it('subtask_completed（force-accept 路径）→ stream snake payload / 无 inbox', () => {
    emit({
      type: 'subtask_completed',
      contractId: makeContractId('c1'),
      subtaskId: makeSubtaskId('t1'),
      forceAccepted: true,
    });

    expect(streamWrite).toHaveBeenCalledTimes(1);
    expect(streamWrite).toHaveBeenCalledWith({
      ts: expect.any(Number),
      type: 'system_notify',
      subtype: 'subtask_completed',
      contract_id: 'c1',
      subtask_id: 't1',
      force_accepted: true,
    });
    expect(inboxFiles()).toHaveLength(0);
  });

  it('verification_failed → stream 全 snake payload / 无 inbox', () => {
    emit({
      type: 'verification_failed',
      contractId: makeContractId('c1'),
      subtaskId: makeSubtaskId('t1'),
      cause: 'llm_rejected',
      feedback: 'rejected by LLM',
      retryCount: 1,
      maxAttempts: 3,
    });

    expect(streamWrite).toHaveBeenCalledTimes(1);
    expect(streamWrite).toHaveBeenCalledWith({
      ts: expect.any(Number),
      type: 'system_notify',
      subtype: 'verification_failed',
      contract_id: 'c1',
      subtask_id: 't1',
      cause: 'llm_rejected',
      feedback: 'rejected by LLM',
      retry_count: 1,
      max_attempts: 3,
    });
    expect(inboxFiles()).toHaveLength(0);
  });

  it('contract_failed（Phase 1396 Step D）→ stream camel payload（reason/evidenceRef/producer）/ 无 inbox', () => {
    emit({
      type: 'contract_failed',
      contractId: makeContractId('c1'),
      reason: 'executor died',
      evidenceRef: 'executor/events.jsonl#seq=42',
      producer: 'event-loop',
    });

    expect(streamWrite).toHaveBeenCalledTimes(1);
    expect(streamWrite).toHaveBeenCalledWith({
      ts: expect.any(Number),
      type: 'system_notify',
      subtype: 'contract_failed',
      contractId: 'c1',
      reason: 'executor died',
      evidenceRef: 'executor/events.jsonl#seq=42',
      producer: 'event-loop',
    });
    // failed 只呈现最终事实；不写 self-inbox、不给 motion 重启/取消处方。
    expect(inboxFiles()).toHaveLength(0);
  });
});
