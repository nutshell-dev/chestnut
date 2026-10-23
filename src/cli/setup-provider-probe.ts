/**
 * Phase 1973 Step C：setup 多端点候选 probe。
 *
 * 五家供应商（DeepSeek/Kimi/Qwen/GLM/MiniMax）在 setup（init 与
 * `config provider add`）中按固定顺序 probe 候选 Anthropic 端点：
 * 第一个 ok 的候选写入配置 preset + base_url；全败不保存并逐候选报告。
 * 运行时不再 probe——重启直接使用落盘 base_url。
 */

import { CliError } from './errors.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  toProviderConfig,
  type LLMProviderConfig,
} from '../foundation/llm-orchestrator/index.js';
import type { PiAiCredentialStore } from '../foundation/llm-provider/index.js';
import { checkLLMConnectionFor, type LLMErrorType } from './llm-connection-check.js';
import type { SetupProbeCandidate } from './setup-provider-catalog.js';

/**
 * 单候选 probe 的 bounded timeout：不把用户生产 timeout 拉满。
 * Qwen 7 候选最坏 ~105s，可接受；保存配置仍使用用户 timeout_ms。
 */
export const SETUP_PROBE_TIMEOUT_MS = 15_000;

export type SetupProbeResult =
  | { ok: true; model: string }
  | { ok: false; errorType: LLMErrorType; message: string; provider: string };

export interface SetupProbeAttempt {
  candidate: SetupProbeCandidate;
  result: SetupProbeResult;
}

export interface SetupProbeOutcome {
  winner?: SetupProbeCandidate;
  winnerModel?: string;
  attempts: SetupProbeAttempt[];
}

/**
 * 纯迭代 helper：按候选顺序逐个 probe，首胜即停（后续候选不调用）；
 * 全败返回全部 attempts。probe 由 caller 注入，便于测试与复用。
 */
export async function probeSetupCandidates(
  candidates: readonly SetupProbeCandidate[],
  probe: (candidate: SetupProbeCandidate) => Promise<SetupProbeResult>,
): Promise<SetupProbeOutcome> {
  const attempts: SetupProbeAttempt[] = [];
  for (const candidate of candidates) {
    const result = await probe(candidate);
    attempts.push({ candidate, result });
    if (result.ok) return { winner: candidate, winnerModel: result.model, attempts };
  }
  return { attempts };
}

export interface SetupCandidateProbeInput {
  label: string;
  /** 可能是 `${REF}` 引用——probe 前经 resolveKey 解析。 */
  apiKey?: string;
  model: string;
}

/**
 * 单个候选的 probe closure：用用户 key/model + 候选 baseUrl 构造 runtime
 * config，bounded timeout 走既有 checkLLMConnectionFor（不新建 provider 栈）。
 * credential 引用解析失败直接抛 CliError，不发起 probe。
 */
export function makeSetupCandidateProbe(
  input: SetupCandidateProbeInput,
  deps: {
    resolveKey: (ref: string) => string | undefined;
    credentials?: PiAiCredentialStore;
  },
): (candidate: SetupProbeCandidate) => Promise<SetupProbeResult> {
  return async (candidate) => {
    const candidateConfig: LLMProviderConfig = {
      preset: candidate.presetId,
      label: input.label,
      ...(input.apiKey !== undefined && { api_key: input.apiKey }),
      model: input.model,
      base_url: candidate.baseUrl, // 显式覆盖 preset 默认
      temperature: 0.7,
      timeout_ms: DEFAULT_LLM_TIMEOUT_MS,
    };
    const runtime = toProviderConfig(candidateConfig);
    if (runtime.apiKey !== undefined) {
      const resolved = deps.resolveKey(runtime.apiKey);
      if (resolved === undefined) {
        throw new CliError(
          `API key reference ${input.apiKey} could not be resolved ` +
          `(not in process env, credentials file, or .env fallbacks)`,
        );
      }
      runtime.apiKey = resolved;
    }
    runtime.timeoutMs = Math.min(runtime.timeoutMs, SETUP_PROBE_TIMEOUT_MS);
    return checkLLMConnectionFor(runtime, {
      ...(deps.credentials !== undefined && { credentials: deps.credentials }),
    });
  };
}
