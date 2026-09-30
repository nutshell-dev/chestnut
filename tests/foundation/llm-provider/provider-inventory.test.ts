/**
 * Phase 1926 Step D：provider inventory 漂移门禁 + 支持表对账。
 *
 * provider-inventory.generated.ts 是 scripts/generate-provider-inventory.mjs 的
 * 静态产物（41 provider / 10 api，含每 provider 的 api 集与 auth 类）。pi-ai
 * 依赖升级导致 inventory 改变时本测试必须失败，要求重新生成 manifest——
 * 与 model-catalog 门禁同纪律。
 *
 * 另守三条不变量：
 * 1. 活安装枚举与快照逐项一致（漂移即红）；
 * 2. 快照出现的每个 api 都有注册 lazy 工厂，且 runtime 注册表与快照 api 集互等
 *    （任一 inventory API 无 factory → 红）；
 * 3. 每个带 piAiProvider 的 preset：provider ∈ inventory 且 defaultModel ∈ 其
 *    静态 catalog（preset↔catalog 一致性；动态 provider radius 无静态 model，
 *    不在 chestnut 配置面，见快照注释）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROVIDER_INVENTORY,
  PROVIDER_INVENTORY_APIS,
  PROVIDER_INVENTORY_PI_AI_VERSION,
  type ProviderInventoryEntry,
} from '../../../src/foundation/llm-provider/provider-inventory.generated.js';
import { PRESETS } from '../../../src/foundation/llm-provider/presets.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-support.js';

const repoRoot = path.resolve(__dirname, '../../..');

describe('provider inventory 漂移门禁（Phase 1926 Step D）', () => {
  it('版本戳 == 已安装 pi-ai 版本', () => {
    const pkgPath = path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-ai', 'package.json');
    const installed = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
    expect(PROVIDER_INVENTORY_PI_AI_VERSION).toBe(installed);
  });

  it('快照与活安装逐项一致（升级 pi-ai 后必须重跑 scripts/generate-provider-inventory.mjs）', async () => {
    const { getBuiltinProviders, getBuiltinModels, builtinProviders } = await import('@earendil-works/pi-ai/providers/all');
    const constructed = builtinProviders() as Array<{
      id: string;
      auth: { apiKey?: { login?: unknown }; oauth?: unknown };
    }>;
    const live: Record<string, ProviderInventoryEntry> = {};
    for (const id of (getBuiltinProviders() as string[]).sort()) {
      const apis = [...new Set((getBuiltinModels(id) as Array<{ api: string }>).map((m) => m.api))].sort();
      const provider = constructed.find((p) => p.id === id);
      expect(provider, `builtin provider constructed: ${id}`).toBeDefined();
      live[id] = {
        apis,
        auth: {
          apiKey: Boolean(provider!.auth.apiKey),
          apiKeyLogin: Boolean(provider!.auth.apiKey?.login),
          oauth: Boolean(provider!.auth.oauth),
        },
      };
    }
    expect(PROVIDER_INVENTORY).toEqual(live);
  });

  it('快照 api 集 == 运行时注册 lazy 工厂集（任一 api 无 factory 即红）', async () => {
    const runtime = await loadPiAiRuntime();
    expect(Object.keys(runtime.apis).sort()).toEqual([...PROVIDER_INVENTORY_APIS].sort());
    for (const [id, entry] of Object.entries(PROVIDER_INVENTORY)) {
      for (const api of entry.apis) {
        expect(runtime.apis[api], `provider ${id} api ${api} has registered factory`).toBeDefined();
      }
    }
  });

  it('每 provider 至少一种 auth 方法且 auth 类 ⊆ {apiKey, oauth}', () => {
    for (const [id, entry] of Object.entries(PROVIDER_INVENTORY)) {
      expect(
        entry.auth.apiKey || entry.auth.oauth,
        `provider ${id} has at least one auth method`,
      ).toBe(true);
    }
  });

  it('ambient 依托 provider（bedrock/vertex）为 apiKey auth 且无 oauth', () => {
    // 两者 apiKey auth 带交互 login（bearer/profile/链选择），同时 resolve 支持
    // 无 stored credential 的环境解析（AWS 链/ADC）——ambient 行为由
    // pi-ai-auth.test.ts 的 getAuth 面断言，本处只锁 auth 类形状。
    expect(PROVIDER_INVENTORY['amazon-bedrock']?.auth).toMatchObject({ apiKey: true, oauth: false });
    expect(PROVIDER_INVENTORY['google-vertex']?.auth).toMatchObject({ apiKey: true, oauth: false });
  });

  it('OAuth provider 集与快照一致（openai-codex 为纯 OAuth）', () => {
    expect(PROVIDER_INVENTORY['openai-codex']?.auth).toEqual({ apiKey: false, apiKeyLogin: false, oauth: true });
    const oauthProviders = Object.entries(PROVIDER_INVENTORY)
      .filter(([, e]) => e.auth.oauth)
      .map(([id]) => id)
      .sort();
    expect(oauthProviders).toEqual(
      ['anthropic', 'github-copilot', 'kimi-coding', 'meta', 'openai-codex', 'openrouter', 'radius', 'xai'],
    );
  });

  it('preset.piAiProvider ∈ inventory；无 apiFormat 的 catalog preset defaultModel 必命中静态 catalog', async () => {
    const { getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
    for (const preset of Object.values(PRESETS)) {
      if (!preset.piAiProvider) continue;
      const entry = PROVIDER_INVENTORY[preset.piAiProvider];
      expect(entry, `preset ${preset.id} piAiProvider ${preset.piAiProvider} in inventory`).toBeDefined();
      // 无 apiFormat 的 preset（Phase 1926 Step D 新增）没有自建 Model 回退——
      // defaultModel 必须 catalog 命中；旧 preset 保留 apiFormat 回退路径不在此约束
      if (!preset.apiFormat && preset.defaultModel) {
        const hit = (getBuiltinModels(preset.piAiProvider) as Array<{ id: string }>)
          .some((m) => m.id === preset.defaultModel);
        expect(hit, `preset ${preset.id} defaultModel ${preset.defaultModel} in catalog`).toBe(true);
      }
    }
  });

  // ── Phase 1927 Step D：反向断言——每个 catalog provider 都有配置策略 ──────────
  // （不再只有 preset→catalog 单向：catalog 任一 provider 必须可经显式
  //   provider_id + 静态 seed model 走通 schema→adapter→runtime 配置链）
  it('每个 catalog provider：provider_id + 静态 seed model 可配置（schema→adapter→runtime catalog 命中）', async () => {
    const { getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
    const { llmProviderConfigSchema } = await import('../../../src/foundation/llm-orchestrator/llm-provider-config-schema.js');
    const { toProviderConfig } = await import('../../../src/foundation/llm-orchestrator/config-adapter.js');
    const { catalogProvidersWithoutPreset } = await import('../../../src/foundation/llm-provider/catalog-strategy.js');

    for (const id of Object.keys(PROVIDER_INVENTORY)) {
      const models = getBuiltinModels(id) as Array<{ id: string }>;
      // 显式 model 规则：静态 seed 必须非空（动态 provider 的配置入口也是 seed）
      expect(models.length, `provider ${id} has static catalog seed models`).toBeGreaterThan(0);

      const config = toProviderConfig(llmProviderConfigSchema.parse({
        provider_id: id,
        model: models[0].id,
      }));
      expect(config.piAiProvider).toBe(id);
      expect(config.model).toBe(models[0].id);
      // 派生 profile 合法：oauth ⇒ inventory 声明 oauth；api_key ⇒ 声明 apiKey
      const profile = config.authProfile;
      if (profile === 'oauth') expect(PROVIDER_INVENTORY[id].auth.oauth).toBe(true);
      else expect(PROVIDER_INVENTORY[id].auth.apiKey).toBe(true);
    }

    // 派生策略与 preset 别名互补覆盖 = universe 全集（无双重封闭来源）
    const uncovered = catalogProvidersWithoutPreset();
    const covered = new Set(Object.values(PRESETS).map((p) => p.piAiProvider).filter(Boolean));
    expect(new Set([...uncovered, ...covered])).toEqual(new Set(Object.keys(PROVIDER_INVENTORY)));
    expect(uncovered.every((id) => !covered.has(id as string))).toBe(true);
  });
});
