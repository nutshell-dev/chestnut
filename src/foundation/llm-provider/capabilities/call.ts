/** Single-provider calls and typed failures; no catalog or credential access. */
import type { PiAiAdapterOptions } from '../pi-ai-adapter.js';
import type { LLMProvider, ProviderConfig } from '../types.js';
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
export type ProviderCallConfig = ProviderConfig;
export type ProviderFactoryOptions = PiAiAdapterOptions;
export type LLMProviderCallCapability = Pick<LLMProvider, 'call' | 'stream'>;
export type LLMProviderFactory = (
  config: ProviderCallConfig,
  options?: ProviderFactoryOptions,
) => LLMProvider;
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

export { createLLMProvider } from '../provider-factory.js';
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
