/**
 * @module L1.LLMProvider.PiAi.Capture
 *
 * 注入 fetch 的 HTTP 错误截获（Phase 1925 Step C，设计稿 D2/G2；
 * Phase 1964 Step C 自 pi-ai-errors.ts 拆出）。
 *
 * 主信号源 = 注入 fetch 截获（status + retry-after + 非 2xx body clone；成功路径
 * 是 SSE 流，绝不 clone——G2 实现约束）。retry-after 只取 typed header
 *（phase 1268 禁令，不从 message 正则推导）。
 *
 * Google 族（google-generative-ai / google-vertex）= 已登记退化族（设计稿 §7 G1）：
 * pi-ai 适配器拒绝注入 fetch、onResponse 不存在，HTTP status 与 retry-after 均
 * 不可得 → 退回文本判定通路（见 pi-ai-classify.ts）。
 */

import type * as PiAi from '@earendil-works/pi-ai';

/** 注入 fetch 的截获结果（每请求一份）。 */
export interface HttpErrorCapture {
  status?: number;
  retryAfter?: string | null;
  body?: string;
  networkError?: unknown;
}

/**
 * 构造截获 fetch：非 2xx 时记录 status/retry-after/body（clone 读文本，原
 * Response 原样返回不扰流）；传输层抛错记录 networkError 后原样上抛。
 * Google 族不得使用（pi-ai 适配器拒绝 custom fetch）——caller 按 api 族跳过。
 */
export function createCapturingFetch(capture: HttpErrorCapture): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      const response = await globalThis.fetch(input, init);
      if (!response.ok) {
        capture.status = response.status;
        capture.retryAfter = response.headers.get('retry-after');
        try {
          capture.body = await response.clone().text();
        } catch {
          // silent: body 读取失败不阻断错误分类（status/header 已在手）
        }
      }
      return response;
    } catch (err) {
      capture.networkError = err;
      throw err;
    }
  };
}

/** 该 model 的 api 是否 Google 退化族（注入 fetch 不可用）。 */
export function isGoogleFamilyApi(api: PiAi.Api | string): boolean {
  return String(api).startsWith('google');
}
