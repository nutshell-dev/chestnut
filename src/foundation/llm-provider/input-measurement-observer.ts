import type { InputMeasurement, InputMeterDescriptor } from './input-meter-types.js';
import { sha256Hex } from '../node-utils/index.js';

export interface InputMeasurementUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type InputMeasurementObservation =
  | {
      kind: 'prepared';
      requestId: string;
      provider: string;
      model: string;
      descriptor: Readonly<InputMeterDescriptor>;
      measurement: InputMeasurement;
      inputHash: string;
      inputSource: 'unlinked';
    }
  | {
      kind: 'completed';
      requestId: string;
      provider: string;
      model: string;
      usage?: InputMeasurementUsage;
      totalUsageInputTokens?: number;
      measuredInputTokens?: number;
      deltaTokens?: number;
      reconciliation: 'matched' | 'mismatch' | 'no_usage' | 'unavailable';
    }
  | {
      kind: 'failed';
      requestId: string;
      provider: string;
      model: string;
      reason: string;
      measuredInputTokens?: number;
    };

export type InputMeasurementObserver = (observation: InputMeasurementObservation) => void;

export function emitInputMeasurement(
  observer: InputMeasurementObserver | undefined,
  observation: InputMeasurementObservation,
): void {
  if (!observer) return;
  try {
    observer(observation);
  } catch {
    // silent: observation is explicitly a non-throwing side channel.
  }
}

export function inputProjectionHash(input: unknown): string {
  return sha256Hex(JSON.stringify(input));
}
