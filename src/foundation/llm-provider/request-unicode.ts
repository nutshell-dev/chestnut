/**
 * LLMInvalidRequestError — provider-side JSON parse rejection 的 typed error。
 *
 * 请求侧 Unicode/circular 序列化守卫随 pi-ai 接管请求序列化而退役
 *（phase 1925 死面、phase 1961 Step B 删除）；本文件只保留 live 的
 * provider JSON parse rejection 错误。
 */

import { LLMError } from './errors.js';

type InvalidRequestReason = 'provider_json_parse_rejected';

export class LLMInvalidRequestError extends LLMError {
  readonly code = 'LLM_INVALID_REQUEST' as const;
  constructor(readonly provider: string, readonly reason: InvalidRequestReason) {
    super(`Invalid LLM request for ${provider}: ${reason}`, {
      provider,
      reason,
    });
  }
}
