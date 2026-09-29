#!/usr/bin/env node
/**
 * Phase 1925 Step C：pi-ai 模型能力目录静态快照生成器（设计稿 D3/G3）。
 *
 * 从已安装的 @earendil-works/pi-ai 枚举全部 builtin provider/model，
 * 生成 src/foundation/llm-provider/model-catalog.generated.ts：
 *   (pi-ai provider id, model id) → { contextWindow, maxTokens, reasoning }
 *
 * 快照随仓库落地（可审计、可回滚、barrel 运行时不引 pi-ai）；文件头记录
 * 来源版本戳（pi-ai 版本 + getBuiltinModelDataGeneratedAt()）。依赖升级后
 * 必须重跑本脚本；漂移由 tests/foundation/llm-provider/model-catalog.test.ts 门禁。
 *
 * 用法：node scripts/generate-model-catalog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const outPath = path.join(repoRoot, 'src', 'foundation', 'llm-provider', 'model-catalog.generated.ts');

const piAiPkgPath = path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-ai', 'package.json');
const piAiVersion = JSON.parse(fs.readFileSync(piAiPkgPath, 'utf8')).version;

const { getBuiltinProviders, getBuiltinModels, getBuiltinModelDataGeneratedAt } = await import('@earendil-works/pi-ai/providers/all');

const entries = {};
for (const provider of getBuiltinProviders()) {
  for (const model of getBuiltinModels(provider)) {
    entries[`${provider}/${model.id}`] = {
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
    };
  }
}

const keys = Object.keys(entries).sort();
const dataGeneratedAt = getBuiltinModelDataGeneratedAt() ?? null;

const lines = [];
lines.push('/**');
lines.push(' * GENERATED FILE — 请勿手改。由 scripts/generate-model-catalog.mjs 生成（Phase 1925 Step C）。');
lines.push(` * 来源：@earendil-works/pi-ai@${piAiVersion}` + (dataGeneratedAt ? `（上游目录数据 generatedAt=${dataGeneratedAt}）` : ''));
lines.push(` * 生成时间：${new Date().toISOString()}；条目数：${keys.length}`);
lines.push(' * 再生成：node scripts/generate-model-catalog.mjs（依赖升级后必须重跑；漂移有测试门禁）');
lines.push(' */');
lines.push('');
lines.push(`export const MODEL_CATALOG_PI_AI_VERSION = ${JSON.stringify(piAiVersion)};`);
lines.push(`export const MODEL_CATALOG_ENTRY_COUNT = ${keys.length};`);
lines.push('');
lines.push('export interface ModelCatalogEntry {');
lines.push('  readonly contextWindow: number;');
lines.push('  readonly maxTokens: number;');
lines.push('  readonly reasoning: boolean;');
lines.push('}');
lines.push('');
lines.push('/** 主键 = `${pi-ai provider id}/${model id}`（G3 决策 1：只按 model id 会静默取错值）。 */');
lines.push('export const MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {');
for (const key of keys) {
  const e = entries[key];
  lines.push(`  ${JSON.stringify(key)}: { contextWindow: ${e.contextWindow}, maxTokens: ${e.maxTokens}, reasoning: ${e.reasoning} },`);
}
lines.push('};');
lines.push('');

fs.writeFileSync(outPath, lines.join('\n'));
console.log(`wrote ${outPath}: ${keys.length} entries from pi-ai@${piAiVersion}`);
