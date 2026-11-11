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

export interface ModelInputMeter {
  readonly descriptor: Readonly<InputMeterDescriptor>;
  measure(input: CompleteInput): InputMeasurement;
}
