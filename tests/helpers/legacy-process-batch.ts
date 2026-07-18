/**
 * Test helper that replicates the old Runtime.processBatch() orchestration.
 *
 * Phase 784 removes processBatch from production Runtime; existing tests that
 * exercised turn-level behavior through processBatch are migrated to this
 * helper so they continue to verify drain → trim → processTurn → ack/nack
 * semantics without duplicating the orchestration in every test file.
 */

import type { Runtime } from '../../src/core/runtime/index.js';
import type { StreamCallbacks } from '../../src/core/agent-executor/stream-callbacks.js';
import { isContextExceededError } from '../../src/foundation/llm-orchestrator/index.js';
import {
  MaxStepsExceededError,
  WallTimeExceededError,
  ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError,
} from '../../src/core/agent-executor/errors.js';
import { LLMAllProvidersFailedError } from '../../src/foundation/llm-orchestrator/errors.js';
import { LockContentionExhaustedError } from '../../src/core/contract/errors.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../src/core/step-executor/signals.js';
import { RUNTIME_AUDIT_EVENTS } from '../../src/core/runtime/runtime-audit-events.js';
import { formatErr } from '../../src/foundation/node-utils/index.js';
import type { TurnResult } from '../../src/core/runtime/types.js';

/**
 * Run one legacy batch: drain inbox, proactive trim, processTurn, ack/nack.
 * Mirrors the deleted Runtime.processBatch() implementation for test backwards
 * compatibility.
 */
export async function runLegacyBatch(
  runtime: Runtime,
  callbacks?: StreamCallbacks,
): Promise<number> {
  const { injected, sources, count, infos, addressedHandles } = await runtime.drainInbox();
  if (count === 0) return 0;

  const sessionManager = (runtime as any).sessionManager;
  const contractManager = (runtime as any).contractManager;
  const auditWriter = (runtime as any).auditWriter;
  const execContext = (runtime as any).execContext;

  // Notify daemon-loop of inbox messages for review_request handling
  if ((callbacks as any)?.onInboxMessages && infos.length > 0) {
    try {
      await (callbacks as any).onInboxMessages(infos);
    } catch (e) {
      const reason = formatErr(e);
      auditWriter.write(RUNTIME_AUDIT_EVENTS.INBOX_HANDLER_FAILED, 'handler=onInboxMessages', `reason=${reason}`);
    }
  }

  const { session } = await sessionManager.load();
  const tools = runtime.getToolsForLLM();
  let messages = [...session.messages, ...injected];
  messages = await runtime.proactiveTrimIfNeeded(messages, session.systemPrompt, tools);

  callbacks?.onTurnStart?.(sources);

  const MAX_REACTIVE_TRIM_RETRIES = 2;
  let reactiveRetries = 0;
  let result: TurnResult;
  while (true) {
    result = await runtime.processTurn(messages, session.systemPrompt, tools, callbacks);
    if (
      result.status !== 'failed' ||
      !isContextExceededError(result.error) ||
      reactiveRetries >= MAX_REACTIVE_TRIM_RETRIES
    ) {
      break;
    }
    reactiveRetries++;
    await runtime.reactiveTrim();
    const { session: trimmedSession } = await sessionManager.load();
    messages = trimmedSession.messages;
  }

  if (result.status === 'success') {
    await runtime.ackHandles(addressedHandles, 'normal_turn_end');
  } else if (result.status === 'interrupted') {
    if (result.cause === 'idle_timeout') {
      await runtime.nackHandles(addressedHandles, result.cause ?? 'idle_timeout', 'graceful_interrupt');
    } else {
      await runtime.ackHandles(addressedHandles, 'graceful_interrupt');
    }
  } else {
    await runtime.nackHandles(addressedHandles, formatErr(result.error) ?? 'failed', 'rollback');

    const err = result.error;
    const isAgentLoopCrash =
      err instanceof MaxStepsExceededError ||
      err instanceof WallTimeExceededError ||
      err instanceof ConsecutiveParseErrorsExceededError ||
      err instanceof ConsecutiveMaxTokensToolUseError ||
      err instanceof LLMAllProvidersFailedError ||
      err instanceof LockContentionExhaustedError;

    if (isAgentLoopCrash) {
      // phase 1121 Step B: process failure 不再 mutate Contract；legacy helper 仅做 audit。
      const hasContract = infos.some(i => i.metadata?.contract_id) ||
        (err instanceof LockContentionExhaustedError && err.contractId);
      if (!hasContract) {
        auditWriter.write(
          RUNTIME_AUDIT_EVENTS.CATCH_UNHANDLED,
          `path=agent_loop_crash_no_contract`,
          `err=${(err as Error).constructor.name}`,
          `reason=${formatErr(err)}`,
        );
      }
    } else if (!(err instanceof PriorityInboxInterrupt || err instanceof UserInterrupt || err instanceof IdleTimeoutSignal)) {
      auditWriter.write(
        RUNTIME_AUDIT_EVENTS.CATCH_UNHANDLED,
        `path=non_interrupt_error`,
        `err=${(err as Error).constructor.name ?? 'Error'}`,
        `reason=${formatErr(err)}`,
      );
    }
  }

  if (result.status !== 'success' && result.error) {
    throw result.error;
  }

  return count;
}
