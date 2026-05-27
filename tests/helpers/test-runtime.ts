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
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { DialogStore } from '../../src/foundation/dialog-store/index.js';
import type { ToolRegistry } from '../../src/foundation/tools/registry.js';

export class TestRuntime extends Runtime {
  /** Override LLM after initialize() — used by regime switch tests with mock LLM. */
  testSetLLM(llm: LLMOrchestrator): void {
    this.llm = llm;
  }

  /** Get current LLM (for assertion or mock-replace patterns). */
  testGetLLM(): LLMOrchestrator {
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
    return this.toolRegistry;
  }

  /** Call buildSystemPrompt() — for motion tests verifying prompt assembly. */
  async testBuildSystemPrompt(): Promise<string> {
    return this.buildSystemPrompt();
  }
}
