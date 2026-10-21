/**
 * @module L1.LLMProvider.PiAi
 * pi-ai 接入兼容 facade（Phase 1964 Step B）：实现已拆为职责文件——
 * `pi-ai-runtime.ts`（动态装载）、`pi-ai-model.ts`（apiFormat→api 映射与
 * Model 解析）、`pi-ai-endpoint.ts`（auth/catalog/credential 装配）。
 * 现有导入路径与公开符号保持不变；新代码应直接依赖职责文件。
 */
export * from './pi-ai-runtime.js';
export * from './pi-ai-model.js';
export * from './pi-ai-endpoint.js';
