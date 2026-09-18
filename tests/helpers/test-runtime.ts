/**
 * TestRuntime — Runtime subclass exposing protected fields/methods for test access.
 *
 * Use in test files instead of `new Runtime(...)` when you need to:
 * - Override `llm` post-initialize (mock LLM for chat() tests)
 * - Inspect `sessionManager` / `lastIdentityHash` / `toolRegistry` for assertions
 * - Call `buildSystemPrompt()` directly
 *
 * Drift safety: subclass `this.X` access is type-checked by TypeScript;
 * Runtime field rename surfaces here at compile time (vs `(runtime as any).X` reflection
 * which silently passes through any name).
 *
 * Same constructor signature as Runtime — drop-in replacement.
 */
import { Runtime } from '../../src/core/runtime/runtime.js';
import type { LLMRuntimeCapability } from '../../src/foundation/llm-orchestrator/index.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { ContractCloseOutcome } from '../../src/core/contract/index.js';
import type { DialogStore } from '../../src/foundation/dialog-store/index.js';
import type { ToolRegistry } from '../../src/foundation/tools/registry.js';
import type { ExecContext } from '../../src/foundation/tools/index.js';

export class TestRuntime extends Runtime {
  /** Override LLM after initialize() — used by regime switch tests with mock LLM.
   * phase 1860 (RT-D1)：窄消费面与转发面单一存储、同步可见。 */
  testSetLLM(llm: LLMOrchestrator): void {
    this.llm = llm;
  }

  /** Get current LLM (Runtime 私有消费面；for assertion or mock-replace patterns). */
  testGetLLM(): LLMRuntimeCapability {
    return this.llm;
  }

  /** Get sessionManager (DialogStore instance) — for archive spy / inspection. */
  testGetSessionManager(): DialogStore {
    return this.sessionManager;
  }

  /** Get lastIdentityHash — for regime switch identity hash transition assertions. */
  testGetLastIdentityHash(): string | undefined {
    return this.lastIdentityHash;
  }

  /** Get toolRegistry — for tool name inspection in motion tests. */
  testGetToolRegistry(): ToolRegistry {
    return this.toolRegistryForwarding;
  }

  /** Get execContext — for regime switch post-commit cleanup observation (phase 1850 Step D). */
  testGetExecContext(): ExecContext {
    return this.execContext;
  }

  /** Get contract close outcome captured by stop() (phase 1860 RT-D5, consumed by Step F). */
  testGetContractCloseOutcome(): ContractCloseOutcome | undefined {
    return this._contractCloseOutcome;
  }

  /** Call buildSystemPrompt() — for motion tests verifying prompt assembly. */
  async testBuildSystemPrompt(): Promise<string> {
    return this.buildSystemPrompt();
  }
}
