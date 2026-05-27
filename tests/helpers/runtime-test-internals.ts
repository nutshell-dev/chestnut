/**
 * Type cast for test access to Runtime private fields/methods.
 *
 * Phase 665 Tier 2 test contract hygiene (vs `as any` 65 sites across 4 files).
 *
 * Pattern: `(runtime as unknown as RuntimeTestInternals).<field>` for test mutation
 * or method invocation that bypasses TS visibility.
 *
 * Note: This is **transitional hygiene**. The underlying issue — tests mutate Runtime
 * private state instead of constructing with proper DI — should be revisited in r85+
 * design phase. Possible cleaner paths:
 * - β: Runtime ctor accept partial deps + test construct with mock
 * - γ: TestRuntime extends Runtime exposing protected internals
 * - δ: vi.spyOn for instance methods (partial coverage)
 *
 * Per `feedback_test_contract_hygiene_typed_cast` (推 Meta 45 升格).
 */

import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { DialogStore } from '../../src/foundation/dialog-store/index.js';
import type { ToolRegistry } from '../../src/foundation/tools/index.js';
import type { OutboxWriter } from '../../src/foundation/messaging/outbox-writer.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { StreamCallbacks } from '../../src/core/runtime/types.js';

export interface RuntimeTestInternals {
  llm: LLMOrchestrator;
  sessionManager: DialogStore;
  toolRegistry: ToolRegistry;
  outboxWriter: OutboxWriter;
  auditWriter: AuditLog;
  lastIdentityHash?: string;
  buildSystemPrompt(): Promise<{ full: string; identityContent: string }>;
  _handleTurnInterrupt(err: unknown, callbacks?: StreamCallbacks): void;
  _hasHighPriorityInbox(): Promise<boolean>;
}
