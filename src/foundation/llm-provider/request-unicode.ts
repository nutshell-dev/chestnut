/**
 * LLM provider request Unicode well-formed gate.
 *
 * Validates every string inside a JSON-like provider request body before it is
 * serialized for the wire. Malformed Unicode is rejected as a typed permanent
 * error instead of being sent to the provider and mis-classified as transient.
 */

import {
  InvalidUnicodeStringError,
  assertWellFormedUnicode,
} from '../node-utils/index.js';
import { LLMError } from './errors.js';

export class LLMInvalidRequestError extends LLMError {
  readonly code = 'LLM_INVALID_REQUEST' as const;
  constructor(
    readonly provider: string,
    readonly reason: 'invalid_unicode' | 'provider_json_parse_rejected',
    readonly valuePath?: string,
    readonly codeUnitIndex?: number,
  ) {
    super(`Invalid LLM request for ${provider}: ${reason}`, {
      provider,
      reason,
      valuePath,
      codeUnitIndex,
    });
  }
}

function assertRequestStrings(
  provider: string,
  value: unknown,
  path = '$',
  seen = new WeakSet<object>(),
): void {
  if (typeof value === 'string') {
    try {
      assertWellFormedUnicode(value);
    } catch (error) {
      if (error instanceof InvalidUnicodeStringError) {
        throw new LLMInvalidRequestError(
          provider,
          'invalid_unicode',
          path,
          error.codeUnitIndex,
        );
      }
      throw error;
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) {
    throw new LLMInvalidRequestError(provider, 'invalid_unicode', path);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertRequestStrings(provider, entry, `${path}[${index}]`, seen)
    );
  } else {
    for (const [key, entry] of Object.entries(value)) {
      try {
        assertWellFormedUnicode(key);
      } catch (error) {
        if (error instanceof InvalidUnicodeStringError) {
          throw new LLMInvalidRequestError(
            provider,
            'invalid_unicode',
            `${path}.${key}`,
            error.codeUnitIndex,
          );
        }
        throw error;
      }
      assertRequestStrings(provider, entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

/**
 * Validate every string in a provider request body is well-formed Unicode,
 * then return the JSON-serialized wire payload.
 *
 * @throws LLMInvalidRequestError if any string contains a lone surrogate or the
 *   body contains a circular reference.
 */
export function serializeProviderRequest(provider: string, body: unknown): string {
  assertRequestStrings(provider, body);
  return JSON.stringify(body);
}
