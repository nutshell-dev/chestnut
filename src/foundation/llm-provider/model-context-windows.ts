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
 *      专用、带 revision 的 legacy catalog alias capability 命中；
 *   3. 仍无法消歧 → 保守最小值（避免超限请求）；
 *   4. 目录未命中 → 既有启发式（默认 256K + 后缀/模型族特判 1M）。
 *
 * 注：本表是各 provider model 的 context window 字面值、不是裁剪相关业务字面；
 * 归 L1 LLMProvider、非 L4 ContextManager。快照与上游版本的漂移有测试门禁
 * （tests/foundation/llm-provider/model-catalog.test.ts）。
 */

import { MODEL_CATALOG } from './model-catalog.generated.js';
import {
  CATALOG_PROVIDER_ALIAS_REVISION,
  resolveLegacyCatalogProviderAlias,
} from './catalog-provider-aliases.js';
import type { CatalogResolution, ContextWindowResolution } from './catalog-resolution-types.js';

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
  { prefix: 'k', minimumMajor: 3, minimumMinor: 0 },
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
 * 为已完成身份解析的结果附加窗口事实。只有 catalog facade 可以调用本函数；
 * endpoint/runtime/guard/trim 必须消费同一个不可变结果，不能再次猜窗口。
 */
export function resolveContextWindowForIdentity(
  identity: Pick<CatalogResolution, 'kind' | 'providerId' | 'modelId' | 'revision' | 'metadata'>
    & { readonly providerHint?: string },
): ContextWindowResolution {
  const finish = (
    contextWindow: number,
    source: ContextWindowResolution['source'],
    aliasRevision?: string,
  ): ContextWindowResolution => Object.freeze({
    contextWindow,
    source,
    providerId: identity.providerId ?? identity.providerHint ?? 'unknown',
    modelId: identity.modelId,
    revision: identity.revision,
    ...(aliasRevision !== undefined && { aliasRevision }),
  });

  if (identity.kind !== 'custom' && identity.metadata) {
    return finish(identity.metadata.contextWindow, 'catalog');
  }

  const modelName = identity.modelId;
  const providerId = identity.providerId ?? identity.providerHint;
  const windows = MODEL_CONTEXT_WINDOWS_BY_ID.get(modelName);

  // 保留 Phase 1977/2144 数值规则，只把来源和 revision 纳入同一解析结果。
  if (windows?.size === 1) return finish(Math.min(...windows), 'catalog');
  const direct = providerId ? MODEL_CATALOG[`${providerId}/${modelName}`] : undefined;
  if (direct) return finish(direct.contextWindow, 'catalog');
  const aliased = providerId ? resolveLegacyCatalogProviderAlias(providerId) : undefined;
  if (aliased) {
    const hit = MODEL_CATALOG[`${aliased}/${modelName}`];
    if (hit) return finish(hit.contextWindow, 'catalog_alias', CATALOG_PROVIDER_ALIAS_REVISION);
  }
  if (windows && windows.size > 1) return finish(Math.min(...windows), 'explicit_fallback');

  if (modelName.endsWith('[1m]')) return finish(1_000_000, 'heuristic');
  for (const pattern of MILLION_TOKEN_PATTERNS) {
    if (modelName.includes(pattern)) return finish(1_000_000, 'heuristic');
  }
  if (matchesMillionModelFamily(modelName)) return finish(1_000_000, 'heuristic');
  return finish(DEFAULT_MODEL_CONTEXT_WINDOW, 'heuristic');
}

/**
 * 旧数值测试/外部兼容入口。生产调用方必须使用 CatalogResolution.window；
 * 本 wrapper 不承载新的业务消费。
 */
export function resolveContextWindow(
  providerId: string | undefined,
  modelName: string | undefined,
): number {
  if (!modelName) return DEFAULT_MODEL_CONTEXT_WINDOW;
  return resolveContextWindowForIdentity({
    kind: 'custom',
    providerId,
    modelId: modelName,
    revision: 'legacy-unrevisioned',
  }).contextWindow;
}
