import type { ToolRegistry } from './types.js';

/**
 * Clone tools with restrictedOverrides from source registry into target registry.
 *
 * Each tool may declare `restrictedOverrides` — DI property overrides applied
 * in restricted execution contexts (e.g., shadow subagents). This function
 * reads those declarations and registers restricted clones.
 *
 * ToolDefinition (name/description/schema) is preserved — KV cache stable.
 */
export function applyRestrictedOverrides(
  targetRegistry: ToolRegistry,
  sourceRegistry: ToolRegistry,
): void {
  for (const tool of sourceRegistry.getAll()) {
    if (tool.restrictedOverrides) {
      const restricted = Object.assign(
        Object.create(Object.getPrototypeOf(tool)),
        tool,
        tool.restrictedOverrides,
      );
      targetRegistry.register(restricted);
    }
  }
}
