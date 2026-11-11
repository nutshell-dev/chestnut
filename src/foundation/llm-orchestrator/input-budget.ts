import type { LLMCallOptions } from './types.js';
import type { LLMProvider, InputMeasurement, ModelInputMeter } from '../llm-provider/index.js';
import { LLMAllProvidersFailedError } from './errors.js';
import type { InputBudgetEvidence } from '../llm-provider/index.js';

export interface InputBudgetObservation {
  readonly meter?: ModelInputMeter;
  readonly measurement: InputMeasurement;
}

/**
 * Measure the complete input for the adapter that is actually about to run.
 * A missing test/dummy capability keeps the historical estimate only for
 * compatibility; a real meter that reports unavailable deliberately falls
 * back to the configured timeout (zero token allowance).
 */
export async function observeInputBudget(
  provider: LLMProvider,
  options: LLMCallOptions,
  legacyEstimate: number,
): Promise<InputBudgetObservation> {
  if (typeof provider.prepareInputMeter !== 'function') {
    return {
      measurement: {
        kind: 'estimated',
        method: 'legacy-cl100k',
        reason: 'adapter_capability_missing',
        tokens: legacyEstimate,
      },
    };
  }
  try {
    const meter = await provider.prepareInputMeter({
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });
    return { meter, measurement: meter.measure(options) };
  } catch (error) {
    return {
      measurement: {
        kind: 'unavailable',
        reason: error instanceof Error ? error.message : 'input_meter_failed',
      },
    };
  }
}

export function timeoutInputTokens(observation: InputBudgetObservation): number {
  return observation.measurement.kind === 'counted' || observation.measurement.kind === 'estimated'
    ? observation.measurement.tokens
    : 0;
}

export function inputBudgetEvidence(error: unknown): readonly InputBudgetEvidence[] {
  if (error instanceof LLMAllProvidersFailedError) {
    return error.failures.flatMap(failure => inputBudgetEvidence(failure.error));
  }
  const evidence = (error as { inputBudget?: InputBudgetEvidence } | null)?.inputBudget;
  return evidence ? [evidence] : [];
}
