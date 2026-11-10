import type { LLMInstanceStateStore } from '../../../src/foundation/llm-orchestrator/instance-state-store.js';
import type { LLMProviderRecoveryState } from '../../../src/foundation/llm-orchestrator/instance-state.js';
import type { InvocationExecutor } from '../../../src/foundation/llm-orchestrator/invocation-executor.js';
import type { LLMProviderRuntime } from '../../../src/foundation/llm-orchestrator/provider-runtime.js';
import type { LLMProbeController } from '../../../src/foundation/llm-orchestrator/probe-controller.js';
import type { LLMRecoveryControllerImpl } from '../../../src/foundation/llm-orchestrator/recovery-ledger.js';

interface OrchestratorTestInternals {
  instanceStateStore: LLMInstanceStateStore;
  invocationExecutor: InvocationExecutor;
  providerRuntime: LLMProviderRuntime;
  probeController: LLMProbeController;
  recoveryController: LLMRecoveryControllerImpl;
}

export function internalsOf(owner: unknown): OrchestratorTestInternals {
  return owner as OrchestratorTestInternals;
}

export function providerStatesOf(owner: unknown): readonly LLMProviderRecoveryState[] {
  return internalsOf(owner).recoveryController.snapshot().providers;
}

export function replaceProviderStates(
  owner: unknown,
  providers: readonly LLMProviderRecoveryState[],
): void {
  const internals = internalsOf(owner);
  const snapshot = internals.recoveryController.snapshot();
  const result = internals.instanceStateStore.commit('test_provider_states', {
    providers: [...providers],
    recovery: snapshot.recovery,
  }, {
    providerIds: internals.providerRuntime.providerIds(),
    force: true,
  });
  if (result.kind === 'failed') throw result.error;
}

export function lastSuccessProviderOf(owner: unknown): any {
  return (internalsOf(owner).invocationExecutor as any).lastSuccessProvider;
}

export function currentStreamingProviderOf(owner: unknown): unknown {
  return (internalsOf(owner).invocationExecutor as any).currentStreamingProvider;
}

export function pauseAutonomousProbe(owner: unknown): void {
  const controller = internalsOf(owner).probeController as unknown as {
    scheduleGeneration: number;
    scheduleTimer?: ReturnType<typeof setTimeout>;
  };
  controller.scheduleGeneration += 1;
  if (controller.scheduleTimer !== undefined) clearTimeout(controller.scheduleTimer);
  controller.scheduleTimer = undefined;
}

export function noteProviderSuccess(owner: unknown, providerIndex: number, updateSelection = true): void {
  const internals = internalsOf(owner);
  internals.recoveryController.noteProviderSuccess(
    internals.providerRuntime.providerIds()[providerIndex]!,
    Date.now(),
    updateSelection,
  );
}
