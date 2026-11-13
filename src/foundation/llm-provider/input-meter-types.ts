/** Dependency-free input measurement contract shared by L1 protocol types and meters. */

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

export interface InputMeterDescriptor {
  revision: string;
  provider: string;
  model: string;
  api: string;
  contextWindow: number;
  explicitMaxTokens?: number;
  profile: string;
}

export type InputMeasurement =
  | { kind: 'counted'; tokens: number; method: 'deepseek-v41-template' }
  | { kind: 'estimated'; tokens: number; method: 'legacy-cl100k'; reason: string }
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
