/** Dependency-free input measurement contract shared by L1 protocol types and meters. */
import type { ContextWindowResolution } from './catalog-resolution-types.js';

export interface CompleteInputMessage {
  role: 'user' | 'assistant' | 'system';
  content: unknown;
}

export interface CompleteInputTool {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface CompleteInput {
  messages: readonly CompleteInputMessage[];
  system?: string;
  tools?: readonly CompleteInputTool[];
}

export interface MeterQualification {
  kind: 'estimated' | 'unavailable';
  method: string;
  projection: string;
  assetRevision: string;
  reason?: string;
  limits: Readonly<{
    supportedTools: 'none' | 'client' | 'server' | 'declared';
  }>;
}

export interface InputMeterDescriptor {
  revision: string;
  provider: string;
  /** Display label used to correlate orchestrator candidates; provider stays canonical. */
  providerLabel?: string;
  /** Actual request wire model; it does not select the tokenizer family. */
  model: string;
  /** Original ProviderConfig.model selection input; absent only in historical audit records. */
  configuredModel?: string;
  api: string;
  contextWindow: number;
  /** 与 endpoint/guard/trim 共享的不可变窗口证据；旧审计可读时允许缺席。 */
  windowResolution?: Readonly<ContextWindowResolution>;
  explicitMaxTokens?: number;
  /** Effective streamSimple option; the SDK may still adjust it for thinking/context. */
  effectiveMaxTokens?: number;
  profile: string;
  /** Optional for historical audit records; newly prepared meters always provide these facts. */
  method?: string;
  projection?: string;
  assetRevision?: string;
  limits?: Readonly<{
    maxInputBytes?: number;
    maxMessages?: number;
    supportedTools: 'none' | 'client' | 'server' | 'declared';
  }>;
}

/** `counted` is read-only compatibility for historical audit events, never a fresh meter result. */
export type InputMeasurement =
  | { kind: 'counted'; tokens: number; method: 'deepseek-v41-template' }
  | { kind: 'estimated'; tokens: number; method: 'legacy-cl100k' | 'deepseek-v41-text' | 'kimi-k3-text' | 'qwen3.8-text' | 'glm5.3-text'; reason: string }
  | { kind: 'unavailable'; reason: string };

export interface MessageAdditiveInputCounter {
  readonly kind: 'message_additive';
  measureFixed(input: Pick<CompleteInput, 'system' | 'tools'>): number;
  measureMessage(message: CompleteInputMessage): number;
}

/** Counting semantics are versioned by the owning meter's descriptor revision. */
export type InputMeasurementCapability =
  | MessageAdditiveInputCounter
  | { readonly kind: 'complete_only' | 'unknown' };

export interface ModelInputMeter {
  readonly descriptor: Readonly<InputMeterDescriptor>;
  readonly capability: InputMeasurementCapability;
  measure(input: CompleteInput): InputMeasurement;
}
