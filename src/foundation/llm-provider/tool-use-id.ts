/**
 * ToolUseId brand type (phase 1358 + phase 140 立、phase 136 §5.B invariant 6 应然推导).
 *
 * SoT: Anthropic LLM protocol (tool_use block id)
 * 形态: 'call_<NN>_<rand16>' (Anthropic 立、跨进程 unique)
 *
 * Invariants:
 * - 模块外不可造（__brand 编译期 check）
 * - runtime 等价 string（audit emit 字面不变、M#7 + phase 393 跨进程契约）
 * - factory 输入非 string / 空 string → throw（编码规范错误段）
 *
 * Extracted to a standalone file to break the circular dependency between
 * `llm-provider/types.ts` and `tool-protocol/index.ts`.
 */

declare const ToolUseIdBrand: unique symbol;
export type ToolUseId = string & { readonly [ToolUseIdBrand]: true };

export function makeToolUseId(s: string): ToolUseId {
  if (!s || typeof s !== 'string') {
    throw new Error(`makeToolUseId: expected non-empty string, got ${typeof s}`);
  }
  return s as ToolUseId;
}
