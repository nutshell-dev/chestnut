/**
 * Read-only projection of correlation facts already owned by an execution input.
 * This module deliberately exposes no prompt or other execution payload.
 */
import type { SubagentJsonValue } from './execution-types.js';
import { decodeSubagentInput, PREPARED_SUBAGENT_INPUT_KIND } from './execution-input.js';

export type SubagentExecutionCorrelation =
  | { readonly kind: 'known'; readonly currentContractId: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly reason: string };

function isRecord(value: SubagentJsonValue): value is { [key: string]: SubagentJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function projectExecutionCorrelation(input: SubagentJsonValue): SubagentExecutionCorrelation {
  if (!isRecord(input)) {
    return { kind: 'unavailable', reason: 'execution input is not an object' };
  }
  if (input.schema_version !== 1) {
    return { kind: 'unavailable', reason: 'unsupported execution input schema version' };
  }
  if (input.kind === 'run_subagent_options') {
    if (input.currentContractId === undefined) return { kind: 'absent' };
    if (typeof input.currentContractId !== 'string' || input.currentContractId.trim() === '') {
      return { kind: 'unavailable', reason: 'currentContractId is not a non-empty string' };
    }
    return { kind: 'known', currentContractId: input.currentContractId };
  }
  if (input.kind === PREPARED_SUBAGENT_INPUT_KIND) {
    try {
      decodeSubagentInput(input);
      return { kind: 'absent' };
    } catch {
      // silent: invalid persisted shapes are returned explicitly as unavailable correlation.
      return { kind: 'unavailable', reason: 'prepared execution input is invalid' };
    }
  }
  return { kind: 'unavailable', reason: 'unsupported execution input kind' };
}
