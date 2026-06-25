/**
 * @module L4.ContextManager
 * ContextManager typed errors
 *
 * Note on division of labour with LLMOrchestrator:
 * - LLMAllProvidersContextExceededError: Orchestrator has exhausted ALL providers and still over context limit.
 * - ContextTrimExhaustedError: a SINGLE provider has been trimmed to the bottom and still over limit.
 */

export class ContextTrimExhaustedError extends Error {
  readonly name = 'ContextTrimExhaustedError';
}
