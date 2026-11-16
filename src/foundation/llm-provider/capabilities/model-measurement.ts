/** Resolved model facts, input measurement and token estimation. */
import type { ModelInputMeter } from '../input-meter.js';
import type { ProviderWireMessage, ToolDefinition } from '../types.js';

export interface LLMModelMeasurementCapability {
  readonly contextWindow: (
    providerId: string | undefined,
    modelName: string | undefined,
  ) => number;
  readonly meter?: ModelInputMeter;
  readonly estimateTextTokens: (text: string) => number;
  readonly estimateMessagesTokens: (messages: readonly ProviderWireMessage[]) => number;
  readonly estimateToolsTokens: (tools: readonly ToolDefinition[]) => number;
}

export type {
  CompleteInput,
  InputMeterDescriptor,
  InputMeasurement,
  InputMeasurementCapability,
  MeterQualification,
  ModelInputMeter,
} from '../input-meter.js';
export {
  emitInputMeasurement,
  inputProjectionHash,
  type InputArtifactRef,
  type InputArtifactStatus,
  type InputMeasurementObservation,
  type InputMeasurementObserver,
  type InputMeasurementUsage,
} from '../input-measurement-observer.js';
export type {
  InputArtifactCapture,
  InputArtifactManifest,
  InputArtifactOwner,
  InputArtifactPolicy,
} from '../input-artifact.js';
export { createDeepseekV41Meter } from '../deepseek-v41-meter.js';
export type { InputBudgetEvidence } from '../errors.js';
export {
  estimateTextTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
} from '../token-estimator.js';
export { resolveContextWindow } from '../model-context-windows.js';
export type { ContextWindowResolution } from '../catalog-strategy.js';
