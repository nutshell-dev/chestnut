#!/usr/bin/env node
/**
 * Phase 1926 Step D：pi-ai provider inventory 静态快照生成器。
 *
 * 从已安装的 @earendil-works/pi-ai 枚举全部 builtin provider：
 *   provider id → { apis（其静态 catalog model 的 api 集）, auth（apiKey/apiKeyLogin/oauth） }
 * 并核验 10 个 catalog api 的 lazy 子路径全部可装载、记录其 id 集。
 *
 * 快照随仓库落地（src/foundation/llm-provider/provider-inventory.generated.ts）；
 * 依赖升级后必须重跑本脚本——漂移由
 * tests/foundation/llm-provider/provider-inventory.test.ts 门禁（红灯要求重新生成）。
 *
 * 用法：node scripts/generate-provider-inventory.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const outPath = path.join(repoRoot, 'src', 'foundation', 'llm-provider', 'provider-inventory.generated.ts');

const piAiPkgPath = path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-ai', 'package.json');
const piAiVersion = JSON.parse(fs.readFileSync(piAiPkgPath, 'utf8')).version;

const { getBuiltinProviders, getBuiltinModels, builtinProviders } = await import('@earendil-works/pi-ai/providers/all');

const providers = {};
const constructed = builtinProviders();
for (const id of getBuiltinProviders().sort()) {
  const apis = [...new Set(getBuiltinModels(id).map((m) => m.api))].sort();
  const provider = constructed.find((p) => p.id === id);
  if (!provider) throw new Error(`builtin provider not constructed: ${id}`);
  providers[id] = {
    apis,
    auth: {
      apiKey: Boolean(provider.auth.apiKey),
      apiKeyLogin: Boolean(provider.auth.apiKey?.login),
      oauth: Boolean(provider.auth.oauth),
    },
  };
}

// 10 个 catalog api 的 lazy 子路径逐个动态装载核验（缺失/改名 → 生成期红灯）
const API_MODULES = [
  ['anthropic-messages', 'anthropicMessagesApi'],
  ['azure-openai-responses', 'azureOpenAIResponsesApi'],
  ['bedrock-converse-stream', 'bedrockConverseStreamApi'],
  ['google-generative-ai', 'googleGenerativeAIApi'],
  ['google-vertex', 'googleVertexApi'],
  ['mistral-conversations', 'mistralConversationsApi'],
  ['openai-codex-responses', 'openAICodexResponsesApi'],
  ['openai-completions', 'openAICompletionsApi'],
  ['openai-responses', 'openAIResponsesApi'],
  ['pi-messages', 'piMessagesApi'],
];
const apis = [];
for (const [apiId, exportName] of API_MODULES) {
  const mod = await import(`@earendil-works/pi-ai/api/${apiId}.lazy`);
  if (typeof mod[exportName] !== 'function') {
    throw new Error(`lazy api export missing: ${apiId}.lazy → ${exportName}`);
  }
  apis.push(apiId);
}

const lines = [];
lines.push('/**');
lines.push(' * GENERATED FILE — 请勿手改。由 scripts/generate-provider-inventory.mjs 生成（Phase 1926 Step D）。');
lines.push(` * 来源：@earendil-works/pi-ai@${piAiVersion}`);
lines.push(` * 生成时间：${new Date().toISOString()}；provider 数：${Object.keys(providers).length}；api 数：${apis.length}`);
lines.push(' * 再生成：node scripts/generate-provider-inventory.mjs（pi-ai 升级后必须重跑；漂移有测试门禁）');
lines.push(' */');
lines.push('');
lines.push(`export const PROVIDER_INVENTORY_PI_AI_VERSION = ${JSON.stringify(piAiVersion)};`);
lines.push('');
lines.push('/** catalog api id 集（lazy 子路径装载核验过的全量支持表）。 */');
lines.push(`export const PROVIDER_INVENTORY_APIS: readonly string[] = ${JSON.stringify(apis, null, 2)};`);
lines.push('');
lines.push('export interface ProviderInventoryEntry {');
lines.push('  /** 该 provider 静态 catalog model 用到的 api 集（动态 provider 可为空）。 */');
lines.push('  readonly apis: readonly string[];');
lines.push('  readonly auth: {');
lines.push('    /** apiKey auth 方法存在（含 ambient-only，如 AWS 链/ADC）。 */');
lines.push('    readonly apiKey: boolean;');
lines.push('    /** apiKey auth 带交互 login（false = ambient-only）。 */');
lines.push('    readonly apiKeyLogin: boolean;');
lines.push('    readonly oauth: boolean;');
lines.push('  };');
lines.push('}');
lines.push('');
lines.push('/** provider id → api/auth 快照（与活安装逐项对账，漂移即红）。 */');
lines.push(`export const PROVIDER_INVENTORY: Record<string, ProviderInventoryEntry> = ${JSON.stringify(providers, null, 2)};`);
lines.push('');

fs.writeFileSync(outPath, lines.join('\n'));
console.log(`✓ wrote ${path.relative(repoRoot, outPath)} (pi-ai@${piAiVersion}, ${Object.keys(providers).length} providers, ${apis.length} apis)`);
