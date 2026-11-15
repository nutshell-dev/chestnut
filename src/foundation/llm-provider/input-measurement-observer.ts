import type { InputMeasurement, InputMeterDescriptor } from './input-meter-types.js';
import { formatErr, sha256Hex } from '../node-utils/index.js';

export interface InputMeasurementUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type InputArtifactStatus = 'available' | 'unavailable' | 'redacted';

/** A durable manifest reference; never a substitute for the artifact bytes. */
export interface InputArtifactRef {
  artifactId: string;
  schemaVersion: 1;
  status: InputArtifactStatus;
  hashAlgorithm: 'sha256';
  contentHash?: string;
  byteLength?: number;
  redactionPolicy?: string;
  /** Stable failure/degradation code; capture errors must not block provider calls. */
  reason?: string;
}

interface InputMeasurementCorrelation {
  invocationId?: string;
  attemptId?: string;
  artifactRef?: InputArtifactRef;
}

interface InputMeasurementTerminalFacts extends InputMeasurementCorrelation {
  descriptorRevision?: string;
  inputHash?: string;
  /** A hash correlates observations; it is not a durable, replayable input artifact. */
  inputSource: 'unlinked' | 'artifact';
  measurement?: InputMeasurement;
}

export type InputMeasurementObservation =
  | (InputMeasurementCorrelation & {
      kind: 'prepared';
      requestId: string;
      provider: string;
      model: string;
      descriptor: Readonly<InputMeterDescriptor>;
      measurement: InputMeasurement;
      inputHash?: string;
      inputSource: 'unlinked' | 'artifact';
    })
  | (InputMeasurementTerminalFacts & {
      kind: 'completed';
      requestId: string;
      provider: string;
      model: string;
      /** Raw SDK usage; normalization is recorded separately and never rewrites these values. */
      usage?: InputMeasurementUsage;
      /** Backward-compatible alias of normalizedUsageInputTokens. */
      totalUsageInputTokens?: number;
      normalizedUsageInputTokens?: number;
      measuredInputTokens?: number;
      deltaTokens?: number;
      reconciliation: 'matched' | 'mismatch' | 'no_usage' | 'unavailable';
      reason?: string;
    })
  | (InputMeasurementTerminalFacts & {
      kind: 'failed';
      requestId: string;
      provider: string;
      model: string;
      reason: string;
      measuredInputTokens?: number;
    });

export type InputMeasurementObserver = (observation: InputMeasurementObservation) => void;

export function emitInputMeasurement(
  observer: InputMeasurementObserver | undefined,
  observation: InputMeasurementObservation,
): void {
  if (!observer) return;
  try {
    observer(observation);
  } catch (error) {
    // Observation is non-throwing, but dropping a formed fact must remain visible.
    console.error( // console: L1 observer has no audit dependency; stderr preserves the dropped-fact signal
      `[LLM INPUT MEASUREMENT CRITICAL] observer failed: request=${observation.requestId} phase=${observation.kind} reason=${formatErr(error)}`,
    );
  }
}

export function inputProjectionHash(input: unknown): string {
  return sha256Hex(JSON.stringify(input));
}
