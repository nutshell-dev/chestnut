/**
 * Phase 1925 Step C（设计稿 D3）：模型目录快照漂移门禁。
 *
 * model-catalog.generated.ts 是 scripts/generate-model-catalog.mjs 的静态产物，
 * 随仓库落地（barrel 运行时不引 pi-ai）。pi-ai 依赖升级后必须重跑生成脚本；
 * 本测试对活安装枚举全量 provider/model 并与快照逐项比对，漂移即红。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MODEL_CATALOG,
  MODEL_CATALOG_ENTRY_COUNT,
  MODEL_CATALOG_PI_AI_VERSION,
} from '../../../src/foundation/llm-provider/model-catalog.generated.js';

const repoRoot = path.resolve(__dirname, '../../..');

describe('model catalog 快照漂移门禁（Phase 1925 Step C / D3）', () => {
  it('版本戳 == 已安装 pi-ai 版本', () => {
    const pkgPath = path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-ai', 'package.json');
    const installed = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
    expect(MODEL_CATALOG_PI_AI_VERSION).toBe(installed);
  });

  it('条目数戳 == 实际条目数', () => {
    expect(Object.keys(MODEL_CATALOG).length).toBe(MODEL_CATALOG_ENTRY_COUNT);
  });

  it('快照与活安装目录逐项一致（升级 pi-ai 后必须重跑生成脚本）', async () => {
    const { getBuiltinProviders, getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
    const live: Record<string, { contextWindow: number; maxTokens: number; reasoning: boolean }> = {};
    for (const provider of getBuiltinProviders() as string[]) {
      for (const model of getBuiltinModels(provider) as Array<{
        id: string; contextWindow: number; maxTokens: number; reasoning: boolean;
      }>) {
        live[`${provider}/${model.id}`] = {
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
        };
      }
    }
    expect(MODEL_CATALOG).toEqual(live);
  });

  it('主键形状 = provider/model，字段为正值数字 + 布尔', () => {
    for (const [key, entry] of Object.entries(MODEL_CATALOG)) {
      expect(key).toMatch(/^[^/]+\/.+/);
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.maxTokens).toBeGreaterThan(0);
      expect(typeof entry.reasoning).toBe('boolean');
    }
  });
});
