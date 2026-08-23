import type { Message } from '../../src/foundation/llm-provider/types.js';
import type { Runtime } from '../../src/core/runtime/runtime.js';
import type { StreamCallbacks } from '../../src/core/agent-executor/index.js';
import type { TurnResult } from '../../src/core/runtime/types.js';
import type { RuntimeTestInternals } from './runtime-test-internals.js';

/**
 * Test-only convenience for driving Runtime's production processTurn entry with
 * the current persisted dialog plus one synthetic user message.
 */
export async function processRuntimeMessage(
  runtime: Runtime,
  message: Message,
  callbacks?: StreamCallbacks,
): Promise<TurnResult> {
  const loadResult = await (runtime as unknown as RuntimeTestInternals).sessionManager.load();
  if (loadResult.source === 'io_error') {
    throw new Error(`Session load failed: ${loadResult.error}`);
  }
  const { session } = loadResult;
  const systemPrompt = session.systemPrompt;
  const tools = runtime.getToolsForLLM();
  const enrichedMessage = message.addedAt
    ? message
    : { ...message, addedAt: new Date().toISOString() };
  const messages = await runtime.proactiveTrimIfNeeded(
    [...session.messages, enrichedMessage],
    systemPrompt,
    tools,
  );

  callbacks?.onTurnStart?.([]);
  return runtime.processTurn(messages, systemPrompt, tools, callbacks);
}
