import { afterEach, describe, expect, it, vi } from 'vitest';
import { trimAndPersist, type DialogStoreMutationCapability, type TrimAndPersistInputs } from '../../../src/core/context_manager/trim-and-persist.js';
import { buildProactiveTrimPolicy } from '../../../src/core/context_manager/trim-v2.js';
import { ContextInputMeasurementError } from '../../../src/core/context_manager/errors.js';
import { CONTEXT_TRIM_ARCHIVED } from '../../../src/core/context_manager/audit-events.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import type {
  InputMeasurement,
  InputMeterDescriptor,
  MessageAdditiveInputCounter,
} from '../../../src/foundation/llm-provider/input-meter-types.js';
import { estimateMessagesTokens } from '../../../src/foundation/llm-provider/token-estimator.js';
import * as tokenEstimator from '../../../src/foundation/llm-provider/token-estimator.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';

const NOW = 1_700_000_000_000;
const RECENT_WINDOW_MS = 86_400_000;
const ASSIGNED_BLOCK_ID = 'phase2220-assigned-block';
const descriptor: InputMeterDescriptor = {
  revision: 'phase2220-additive-failure', provider: 'test', model: 'test', api: 'test',
  contextWindow: 200, profile: 'legacy-cl100k-v2',
};

function estimated(tokens: number): InputMeasurement {
  return { kind: 'estimated', tokens, method: 'legacy-cl100k', reason: 'test' };
}

function makeMessages(): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'text', text: `original ${'测'.repeat(400)}` }],
      addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString(),
    },
    { role: 'user', content: 'recent', addedAt: new Date(NOW).toISOString() },
  ];
}

function makeAudit() {
  const events: string[][] = [];
  return {
    events,
    write: vi.fn((event: string, ...details: string[]) => { events.push([event, ...details]); }),
  };
}

function makeStore(afterFirstSave?: () => void) {
  let saves = 0;
  const save = vi.fn(async () => {
    saves++;
    if (saves === 1) afterFirstSave?.();
    return {
      blockIndexPersisted: true,
      assignedBlockIds: saves === 1
        ? [{ messageIndex: 0, blockIndex: 0, blockId: ASSIGNED_BLOCK_ID, shortId: 'phase2220' }]
        : [],
    };
  });
  const archive = vi.fn(async () => {});
  const dialogStore: DialogStoreMutationCapability = { save, archive };
  return { save, archive, dialogStore };
}

function makeInputs(
  measurementCapability: MessageAdditiveInputCounter,
  store: ReturnType<typeof makeStore>,
  messages = makeMessages(),
  audit = makeAudit(),
): TrimAndPersistInputs {
  return {
    messages,
    systemPrompt: 'sys',
    toolsForLLM: [],
    contextWindow: 200,
    recentWindowMs: RECENT_WINDOW_MS,
    previewBytes: 100,
    dialogStore: store.dialogStore,
    audit,
    triggerKind: 'proactive_cache_idle',
    policy: buildProactiveTrimPolicy(200),
    measureComplete: () => estimated(200),
    measurementCapability,
    measurementDescriptor: descriptor,
    now: NOW,
  };
}

async function expectMeasurementError(
  promise: Promise<unknown>,
  reason: string,
  expectedDescriptor: InputMeterDescriptor,
): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContextInputMeasurementError);
  if (!(error instanceof ContextInputMeasurementError)) {
    throw new Error('expected ContextInputMeasurementError');
  }
  expect(error.reason).toBe(reason);
  expect(error.descriptor).toBe(expectedDescriptor);
}

function expectNoSubmittedTrim(audit: ReturnType<typeof makeAudit>): void {
  expect(audit.events.some(event => event[0] === CONTEXT_TRIM_ARCHIVED && event.includes('submitted=true'))).toBe(false);
}

afterEach(() => vi.restoreAllMocks());

describe('additive measurement failure lifecycle', () => {
  it('fails at fixed measurement before any persistence', async () => {
    const store = makeStore();
    const audit = makeAudit();
    const messages = makeMessages();
    const before = JSON.stringify(messages);
    const capability: MessageAdditiveInputCounter = {
      kind: 'message_additive',
      measureFixed: () => ({ kind: 'unavailable', reason: 'fixed_unavailable' }),
      measureMessage: message => estimated(estimateMessagesTokens([message])),
    };

    await expectMeasurementError(trimAndPersist(makeInputs(capability, store, messages, audit)), 'fixed_unavailable', descriptor);

    expect(store.save).not.toHaveBeenCalled();
    expect(store.archive).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toBe(before);
    expectNoSubmittedTrim(audit);
  });

  it('fails at the first initial message before any persistence or input mutation', async () => {
    const store = makeStore();
    const audit = makeAudit();
    const messages = makeMessages();
    const before = JSON.stringify(messages);
    const capability: MessageAdditiveInputCounter = {
      kind: 'message_additive',
      measureFixed: () => estimated(0),
      measureMessage: message => typeof message.content !== 'string'
        && message.content.some(block => block.type === 'text' && block.text.startsWith('original'))
        ? { kind: 'unavailable', reason: 'initial_message_unavailable' }
        : estimated(estimateMessagesTokens([message])),
    };

    await expectMeasurementError(
      trimAndPersist(makeInputs(capability, store, messages, audit)), 'initial_message_unavailable', descriptor,
    );

    expect(store.save).not.toHaveBeenCalled();
    expect(store.archive).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toBe(before);
    expectNoSubmittedTrim(audit);
  });

  it('fails at the first summary replacement without saving a candidate', async () => {
    const store = makeStore();
    const audit = makeAudit();
    const capability: MessageAdditiveInputCounter = {
      kind: 'message_additive',
      measureFixed: () => estimated(0),
      measureMessage: message => message.systemSubtype === 'context_trim_summary'
        ? { kind: 'unavailable', reason: 'summary_replacement_unavailable' }
        : estimated(estimateMessagesTokens([message])),
    };

    await expectMeasurementError(
      trimAndPersist(makeInputs(capability, store, makeMessages(), audit)), 'summary_replacement_unavailable', descriptor,
    );

    expect(store.save).not.toHaveBeenCalled();
    expect(store.archive).not.toHaveBeenCalled();
    expectNoSubmittedTrim(audit);
  });

  it('preserves the pre-trim save and assigned id when second-pass initial measurement fails', async () => {
    const store = makeStore();
    const audit = makeAudit();
    const messages = makeMessages();
    const capability: MessageAdditiveInputCounter = {
      kind: 'message_additive',
      measureFixed: () => estimated(0),
      measureMessage: message => typeof message.content !== 'string'
        && message.content.some(block => block.blockId === ASSIGNED_BLOCK_ID)
        ? { kind: 'unavailable', reason: 'second_initial_unavailable' }
        : estimated(estimateMessagesTokens([message])),
    };

    await expectMeasurementError(
      trimAndPersist(makeInputs(capability, store, messages, audit)), 'second_initial_unavailable', descriptor,
    );

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.archive).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('original'), blockId: ASSIGNED_BLOCK_ID }),
    ]);
    expectNoSubmittedTrim(audit);
  });

  it('keeps the pre-trim save when second-pass summary replacement measurement fails', async () => {
    let preSaveCompleted = false;
    const store = makeStore(() => { preSaveCompleted = true; });
    const audit = makeAudit();
    const messages = makeMessages();
    const capability: MessageAdditiveInputCounter = {
      kind: 'message_additive',
      measureFixed: () => estimated(0),
      measureMessage: message => preSaveCompleted && message.systemSubtype === 'context_trim_summary'
        ? { kind: 'unavailable', reason: 'second_summary_unavailable' }
        : estimated(estimateMessagesTokens([message])),
    };

    await expectMeasurementError(
      trimAndPersist(makeInputs(capability, store, messages, audit)), 'second_summary_unavailable', descriptor,
    );

    expect(preSaveCompleted).toBe(true);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.archive).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('original'), blockId: ASSIGNED_BLOCK_ID }),
    ]);
    expectNoSubmittedTrim(audit);
  });

  it('carries a real L1 additive failure through trimAndPersist without leaking the encoding exception', async () => {
    const config: ProviderConfig = {
      name: 'offline', model: 'unknown-model', apiFormat: 'anthropic',
      baseUrl: 'https://offline.invalid', apiKey: 'offline-only', temperature: 0, timeoutMs: 1_000,
    };
    const meter = await createLLMProvider(config).prepareInputMeter();
    if (meter.capability.kind !== 'message_additive') {
      throw new Error(`expected message-additive meter, got ${meter.capability.kind}`);
    }
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockImplementation(() => {
      throw new SyntaxError('L1 encoding sentinel');
    });
    const store = makeStore();
    const audit = makeAudit();
    const messages = makeMessages();

    await expectMeasurementError(trimAndPersist({
      ...makeInputs(meter.capability, store, messages, audit),
      measurementDescriptor: meter.descriptor,
      measureComplete: candidate => meter.measure({ system: 'sys', tools: [], messages: candidate }),
    }), 'legacy_cl100k_estimate_unavailable:SyntaxError', meter.descriptor);

    expect(store.save).not.toHaveBeenCalled();
    expect(store.archive).not.toHaveBeenCalled();
    expectNoSubmittedTrim(audit);
  });
});
