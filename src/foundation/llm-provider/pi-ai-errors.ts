/**
 * @module L1.LLMProvider.PiAi
 * pi-ai 错误面兼容 facade（Phase 1964 Step C）：实现已拆为职责文件——
 * `pi-ai-capture.ts`（fetch 截获）、`pi-ai-error-text.ts`（文本 shim）、
 * `pi-ai-classify.ts`（capture/textual 分类器）、`pi-ai-success.ts`（成功响应检查）。
 * 现有导入路径与公开符号保持不变；新代码应直接依赖职责文件。
 */
export * from './pi-ai-capture.js';
export * from './pi-ai-error-text.js';
export * from './pi-ai-classify.js';
export * from './pi-ai-success.js';
