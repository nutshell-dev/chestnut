/**
 * Phase 2188: wire business metadata → Runtime guidance envelope → owner binding。
 *
 * 直接经 Messaging codec 构造/读取消息，再调用 Runtime.formatPreparedInbox，
 * 防止测试用手工 extraMeta 绕过生产字段分类链。
 */

import { describe, expect, it, vi } from 'vitest';
import { createMotionGuidanceRegistry } from '../../../src/assembly/guidance/registry.js';
import { clawOutboxSummaryGuidanceBinding } from '../../../src/assembly/guidance/bindings/claw-outbox-summary.js';
import { contractEventsGuidanceBinding } from '../../../src/assembly/guidance/bindings/contract-events.js';
import { registerCliGuidance } from '../../../src/cli-protocol/index.js';
import { encodeContractEventsGuidance } from '../../../src/core/contract/index.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { encodeOutboxSummaryGuidance } from '../../../src/core/claw-topology/jobs/outbox-summary/guidance-state.js';
import type { OutboxSummaryState } from '../../../src/core/claw-topology/jobs/outbox-summary/types.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import type { GuidanceEnvelope, PreparedInboxBatch } from '../../../src/core/runtime/types.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import { decodeInbox, encodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { createInboxMessageTypeRegistry } from '../../../src/foundation/messaging/index.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import { makeAudit } from '../../helpers/audit.js';

const SUMMARY_BODY = '未读消息提醒：扫描发现 2 个 claw 共 4 条未读消息。';
const VALID_HASH = 'abc123def456';

function makeSummaryState(): OutboxSummaryState {
  return {
    counts: { clawA: 3, clawB: 1 },
    total_claws: 2,
    total_msgs: 4,
    file_set: ['clawA:m1.md', 'clawA:m2.md', 'clawA:m3.md', 'clawB:m4.md'],
    hash: VALID_HASH,
    previews: { clawA: 'hello', clawB: 'world' },
    failed_claws: [],
    incomplete: false,
  };
}

function v1Metadata(): Record<string, string> {
  return { ...encodeOutboxSummaryGuidance(makeSummaryState()) };
}

function legacyMetadata(): Record<string, string> {
  const metadata = v1Metadata();
  delete metadata.guidance_schema_version;
  return {
    ...metadata,
    hash: VALID_HASH,
    failed_claws: '[]',
    incomplete: 'false',
  };
}

function decodeWire(type: string, body: string, metadata: Record<string, string>): InboxMessage {
  const message: InboxMessage = {
    id: `${type}-phase2188`,
    type,
    from: 'system',
    to: 'motion',
    content: body,
    priority: 'normal',
    timestamp: '2026-11-17T10:00:00.000Z',
  };
  return decodeInbox(encodeInbox(message, metadata));
}

function batchOf(message: InboxMessage): PreparedInboxBatch {
  return {
    entries: [{
      message,
      handle: {
        filePath: `/virtual/inflight/${message.id}.md`,
        originalFileName: `${message.id}.md`,
      } as PreparedInboxBatch['entries'][number]['handle'],
    }],
  };
}

function buildRuntime() {
  const sink = makeAudit();
  const envelopes: GuidanceEnvelope[] = [];
  const formatterRegistry = createInboxMessageTypeRegistry();
  for (const type of ['claw_outbox_summary', 'contract_events']) {
    formatterRegistry.register({
      owner: 'phase2188-test',
      type,
      rendering: { kind: 'standard', presentation: 'system' },
    });
  }
  const guidanceRegistry = createMotionGuidanceRegistry();
  registerCliGuidance(guidanceRegistry, [
    clawOutboxSummaryGuidanceBinding,
    contractEventsGuidanceBinding,
  ]);
  const runtime = new Runtime({
    clawId: 'motion',
    clawDir: '/virtual/motion',
    idleTimeoutMs: 0,
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    },
    dependencies: {
      systemFs: {} as never,
      auditWriter: sink.audit,
      snapshot: {} as never,
      sessionManager: {} as never,
      inboxReader: {} as never,
      llm: {} as never,
      llmOrchestrator: {} as never,
      toolRegistry: {} as never,
      toolExecutor: {} as never,
      contractManager: {} as never,
      taskSystem: {} as never,
      skillRegistry: {} as never,
      permissionChecker: {} as never,
      fsFactory: () => ({}) as never,
      dialogStoreFactory: vi.fn(),
      formatterRegistry,
      guidanceCompose: (input) => {
        envelopes.push(input);
        return guidanceRegistry.compose(input);
      },
    },
  });
  return { runtime, envelopes, events: sink.events };
}

describe('phase 2188: wire metadata → guidance conservation', () => {
  it('v1 summary 业务字段到达真实 binding，未知扩展与 internal diagnostics 分通道保留', async () => {
    const decoded = decodeWire('claw_outbox_summary', SUMMARY_BODY, {
      ...v1Metadata(),
      unknown_extension: 'preserved',
      __decode_note: 'internal-only',
    });
    const { runtime, envelopes, events } = buildRuntime();

    const result = await runtime.formatPreparedInbox(batchOf(decoded));

    expect(decoded.metadata).toMatchObject({
      'summary-hash': VALID_HASH,
      unknown_extension: 'preserved',
    });
    expect(decoded.extraMeta).toEqual({ __decode_note: 'internal-only' });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toEqual({
      type: 'claw_outbox_summary',
      from: 'system',
      meta: decoded.metadata,
      internal: decoded.extraMeta,
    });
    expect(envelopes[0].meta['summary-hash']).toBe(VALID_HASH);
    expect(envelopes[0].meta.__decode_note).toBeUndefined();
    expect(result.injected[0]?.content).toContain('读取并消费');
    expect(result.injected[0]?.content).toContain('chestnut claw clawA outbox --limit 3');
    expect(result.injected[0]?.content).toContain('chestnut claw clawB outbox --limit 1');
    expect(result.infos[0]).toBe(decoded);
    expect(events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED)).toBe(false);
    expect(events.flat().join(' ')).not.toContain('summary-hash missing or empty');
  });

  it('legacy summary wire 仍可经真实 codec/runtime/binding 生成 guidance', async () => {
    const decoded = decodeWire('claw_outbox_summary', SUMMARY_BODY, legacyMetadata());
    const { runtime, events } = buildRuntime();

    const result = await runtime.formatPreparedInbox(batchOf(decoded));

    expect(result.injected[0]?.content).toContain(SUMMARY_BODY);
    expect(result.injected[0]?.content).toContain('chestnut claw clawA outbox --limit 3');
    expect(events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED)).toBe(false);
  });

  const malformedCases: Array<{
    name: string;
    field: string;
    mutate: (metadata: Record<string, string>) => void;
  }> = [
    {
      name: '缺 summary-hash',
      field: 'summary-hash',
      mutate: metadata => { delete metadata['summary-hash']; },
    },
    {
      name: '坏 summary-hash',
      field: 'summary-hash',
      mutate: metadata => { metadata['summary-hash'] = 'bad-hash'; },
    },
    {
      name: '缺 counts',
      field: 'counts',
      mutate: metadata => { delete metadata.counts; },
    },
  ];

  it.each(malformedCases)('$name → 保留正文/原始 metadata，并写 typed failure audit', async ({ field, mutate }) => {
    const malformed = v1Metadata();
    mutate(malformed);
    const decoded = decodeWire('claw_outbox_summary', SUMMARY_BODY, malformed);
    const { runtime, events } = buildRuntime();

    const result = await runtime.formatPreparedInbox(batchOf(decoded));

    expect(result.injected).toHaveLength(1);
    expect(result.injected[0]?.content).toContain(SUMMARY_BODY);
    expect(result.injected[0]?.content).not.toContain('读取并消费');
    expect(result.sources[0]?.body).toBe(SUMMARY_BODY);
    expect(result.infos[0]?.metadata).toEqual(malformed);
    const failure = events.find(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED);
    expect(failure).toBeDefined();
    expect(failure?.slice(1).join(' ')).toContain('type=claw_outbox_summary');
    expect(failure?.slice(1).join(' ')).toContain('schema_invalid');
    expect(failure?.slice(1).join(' ')).toContain(`field=${field}`);
    const injected = events.find(e => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_INJECT);
    expect(injected?.slice(1).join(' ')).toContain('type=claw_outbox_summary');
    expect(injected?.slice(1).join(' ')).toContain('from=system');
  });

  it('其他 system metadata 仍到达原 binding，Runtime 不改写 decoded message', async () => {
    const metadata = {
      ...encodeContractEventsGuidance([{
        clawId: makeClawId('worker-1'),
        contractId: makeContractId('contract-1'),
      }]),
      unknown_extension: 'preserved',
    };
    const decoded = decodeWire('contract_events', '[contract_completed] worker-1', metadata);
    const { runtime, envelopes, events } = buildRuntime();

    const result = await runtime.formatPreparedInbox(batchOf(decoded));

    expect(envelopes[0]?.meta).toBe(decoded.metadata);
    expect(result.infos[0]?.metadata).toEqual(metadata);
    expect(result.injected[0]?.content).toContain('chestnut claw worker-1 trace --contract contract-1');
    expect(events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED)).toBe(false);
  });
});
