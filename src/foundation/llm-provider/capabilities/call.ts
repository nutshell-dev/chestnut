/** Single-provider calls, input handles and typed failures; no catalog or credential access. */
import type { LLMProvider } from '../types.js';
import type {
  LLMError,
  LLMRateLimitError,
  LLMQuotaError,
  LLMTimeoutError,
  LLMAuthError,
  LLMNetworkError,
  LLMEmptyResponseError,
  LLMModelNotFoundError,
  LLMContextExceededError,
  LLMOutputBudgetExceededError,
  LLMStreamAbortedError,
} from '../errors.js';
import type { LLMInvalidRequestError } from '../request-unicode.js';

export type {
  LLMProvider,
  LLMCallOptions,
  LLMResponse,
  ProviderStreamChunk,
  ProviderAdapter,
  AuditSink,
} from '../types.js';
export type {
  ProviderAuthenticationInput,
  ProviderDescriptor,
  ProviderFactory,
  ProviderHandle,
  ProviderInput,
} from '../provider-connection.js';
export { DEFAULT_LLM_TIMEOUT_MS } from '../defaults.js';
export type LLMProviderCallCapability = Pick<LLMProvider, 'call' | 'stream'>;
export type LLMProviderFailureClass =
  | LLMError
  | LLMRateLimitError
  | LLMQuotaError
  | LLMTimeoutError
  | LLMAuthError
  | LLMNetworkError
  | LLMEmptyResponseError
  | LLMModelNotFoundError
  | LLMContextExceededError
  | LLMOutputBudgetExceededError
  | LLMStreamAbortedError
  | LLMInvalidRequestError;

export { createProviderFromInput } from '../provider-factory.js';
export { describeProviderInput } from '../provider-connection.js';
export { LLMInvalidRequestError } from '../request-unicode.js';
export {
  LLMError,
  LLMRateLimitError,
  LLMQuotaError,
  LLMTimeoutError,
  LLMAuthError,
  LLMNetworkError,
  LLMEmptyResponseError,
  LLMModelNotFoundError,
  LLMContextExceededError,
  LLMOutputBudgetExceededError,
  LLMStreamAbortedError,
} from '../errors.js';
