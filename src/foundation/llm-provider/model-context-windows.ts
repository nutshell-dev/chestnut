/**
 * @module L1.LLMProvider.ModelContextWindows
 *
 * Model context window (token) 上限解析。
 *
 * phase 440 在 step-executor 立、phase 453 抽 L1（M#3 model 字面与 LLM API 协议层同源）、
 * phase 684 改为「默认 256K + 子串特判 1M」机制（替代精确 model 名映射、避免表 stale）、
 * Phase 1925 Step C 改 provider 感知签名（设计稿 G3 决策）、
 * Phase 1977 改判为**模型优先**（用户 2026-10-23 决策，覆盖 G3「不做 id-only 兜底」）：
 *   1. model id 在目录中只有唯一 contextWindow → 直接使用（模型选择是权威输入，
 *      不依赖 provider/preset label）；
 *   2. 同名 model 有多组值 → exact `(provider id, model id)` 精确命中消歧；否则经
 *      PRESETS.piAiProvider/catalogProvider 别名命中（Phase 1975 metadata-only 映射）；
 *   3. 仍无法消歧 → 保守最小值（避免超限请求）；
 *   4. 目录未命中 → 既有启发式（默认 256K + 后缀/模型族特判 1M）。
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
const MILLION_TOKEN_PATTERNS: readonly string[] = ['claude', 'gemini', 'deepseek-v4'] as const;

/** Phase 2144：版本阈值按数字段比较，模型族前缀和版本后的边界必须明确。 */
const MILLION_MODEL_VERSION_RULES = [
  { prefix: 'doubao-seed-', minimumMajor: 2, minimumMinor: 1 },
  { prefix: 'kimi-k', minimumMajor: 3, minimumMinor: 0 },
  { prefix: 'glm-', minimumMajor: 5, minimumMinor: 0 },
  { prefix: 'MiniMax-M', minimumMajor: 3, minimumMinor: 0 },
] as const;

function hasVersionAtLeast(
  modelName: string,
  prefix: string,
  minimumMajor: number,
  minimumMinor: number,
): boolean {
  if (!modelName.startsWith(prefix)) return false;
  const match = /^(\d+)(?:\.(\d+))?(?:\.\d+)*(?:-|$)/.exec(modelName.slice(prefix.length));
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}

function matchesMillionModelFamily(modelName: string): boolean {
  if (/^deepseek-flash(?:-|$)/.test(modelName)) return true;
  return MILLION_MODEL_VERSION_RULES.some((rule) =>
    hasVersionAtLeast(modelName, rule.prefix, rule.minimumMajor, rule.minimumMinor),
  );
}

/**
 * Phase 1977：model id → 目录中出现的 contextWindow 集合。
 * key 按首个 `/` 拆分 provider/model（model id 自身可含 `/`，取首斜杠后的完整 id）。
 */
const MODEL_CONTEXT_WINDOWS_BY_ID: ReadonlyMap<string, ReadonlySet<number>> = (() => {
  const map = new Map<string, Set<number>>();
  for (const [key, entry] of Object.entries(MODEL_CATALOG)) {
    const slash = key.indexOf('/');
    if (slash < 0) continue;
    const modelId = key.slice(slash + 1);
    let windows = map.get(modelId);
    if (!windows) {
      windows = new Set<number>();
      map.set(modelId, windows);
    }
    windows.add(entry.contextWindow);
  }
  return map;
})();

/**
 * 解析 (provider, model) 对应的 context window 上限。
 *
 * Phase 1977 模型优先（覆盖 Phase 1925 G3）：model id 唯一目录值优先；同名多值
 * 由 provider/preset 别名精确消歧，无法消歧取保守最小值；目录未命中走启发式。
 * providerId 接受 pi-ai catalog provider id 或 chestnut preset id（经
 * PRESETS.piAiProvider 显式别名，缺省回退 catalogProvider）；不再作为默认回退依据。
 * Phase 1925 Step C 界面变更：签名由 (modelName?) 改为 (providerId, modelName)，
 * 调用点（runtime.ts ×3）传 providerInfo?.name。
 */
export function resolveContextWindow(
  providerId: string | undefined,
  modelName: string | undefined,
): number {
  if (!modelName) return DEFAULT_MODEL_CONTEXT_WINDOW;

  const windows = MODEL_CONTEXT_WINDOWS_BY_ID.get(modelName);

  // 1) model id 在目录中唯一 → 模型选择权威，不依赖 provider label
  if (windows && windows.size === 1) {
    return Math.min(...windows);
  }

  // 2) 同名多值 → provider 精确命中 / preset 别名消歧
  const direct = providerId ? MODEL_CATALOG[`${providerId}/${modelName}`] : undefined;
  if (direct) return direct.contextWindow;
  const aliased = providerId
    ? (PRESETS[providerId]?.piAiProvider ?? PRESETS[providerId]?.catalogProvider)
    : undefined;
  if (aliased) {
    const hit = MODEL_CATALOG[`${aliased}/${modelName}`];
    if (hit) return hit.contextWindow;
  }

  // 3) 同名多值仍无法消歧 → 保守最小值
  if (windows && windows.size > 1) {
    return Math.min(...windows);
  }

  // 4) 目录未命中 → 既有子串 + Phase 2144 显式后缀/模型族启发式
  if (modelName.endsWith('[1m]')) return 1_000_000;
  for (const pattern of MILLION_TOKEN_PATTERNS) {
    if (modelName.includes(pattern)) return 1_000_000;
  }
  if (matchesMillionModelFamily(modelName)) return 1_000_000;
  return DEFAULT_MODEL_CONTEXT_WINDOW;
}
