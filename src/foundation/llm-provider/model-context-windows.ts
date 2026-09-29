/**
 * @module L1.LLMProvider.ModelContextWindows
 *
 * Model context window (token) 上限解析。
 *
 * phase 440 在 step-executor 立、phase 453 抽 L1（M#3 model 字面与 LLM API 协议层同源）、
 * phase 684 改为「默认 256K + 子串特判 1M」机制（替代精确 model 名映射、避免表 stale）、
 * Phase 1925 Step C 改 provider 感知签名（设计稿 G3 决策）：
 *   1. exact `(pi-ai provider id, model id)` 命中生成快照 MODEL_CATALOG → 取目录值；
 *   2. provider 为 chestnut preset id 时经 PRESETS.piAiProvider 显式别名再查一次；
 *   3. 未命中 → 既有启发式（默认 256K + 子串特判 1M）回退，不做 id-only 兜底
 *      （网关限额与官方端点可不同——azure vs openai 同 model id 差 3.9×，宁保守）。
 *
 * 注：本表是各 provider model 的 context window 字面值、不是裁剪相关业务字面；
 * 归 L1 LLMProvider、非 L4 ContextManager。快照与上游版本的漂移有测试门禁
 * （tests/foundation/llm-provider/model-catalog.test.ts）。
 */

import { MODEL_CATALOG } from './model-catalog.generated.js';
import { PRESETS } from './presets.js';

/** 默认 context window（model 名未命中 1M 特判时 fallback、phase 684 改 128K → 256K） */
const DEFAULT_MODEL_CONTEXT_WINDOW = 256_000;

/**
 * Model 名含以下任一子串即视为 1M context window。
 * phase 684 立：用子串特判替代具体 model 名映射、避免表 stale（model 命名快速演进）。
 * 大小写敏感（按用户拍板的字面值匹配）。
 */
const MILLION_TOKEN_PATTERNS: readonly string[] = [
  'claude',
  'gemini',
  'deepseek-v4',
  'glm-5',
  'MiniMax-M3',
] as const;

/**
 * 解析 (provider, model) 对应的 context window 上限。
 *
 * providerId 接受 pi-ai catalog provider id 或 chestnut preset id（经
 * PRESETS.piAiProvider 显式别名）；undefined/未知 → 启发式回退。
 * Phase 1925 Step C 界面变更：签名由 (modelName?) 改为 (providerId, modelName)，
 * 调用点（runtime.ts ×3）传 providerInfo?.name。
 */
export function resolveContextWindow(
  providerId: string | undefined,
  modelName: string | undefined,
): number {
  if (modelName) {
    const direct = providerId ? MODEL_CATALOG[`${providerId}/${modelName}`] : undefined;
    if (direct) return direct.contextWindow;
    const aliased = providerId ? PRESETS[providerId]?.piAiProvider : undefined;
    if (aliased) {
      const hit = MODEL_CATALOG[`${aliased}/${modelName}`];
      if (hit) return hit.contextWindow;
    }
  }
  if (!modelName) return DEFAULT_MODEL_CONTEXT_WINDOW;
  for (const pattern of MILLION_TOKEN_PATTERNS) {
    if (modelName.includes(pattern)) return 1_000_000;
  }
  return DEFAULT_MODEL_CONTEXT_WINDOW;
}
