import type { ContentBlock } from './types.js';

/**
 * Runtime assertion that a value is a ContentBlock array.
 * Replaces `as unknown[]` cast escape hatch with explicit validation.
 * Phase 980 D fork — α-typeGuard dominant (ROI/cost).
 */
export function assertContentBlocks(value: unknown): asserts value is ContentBlock[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected ContentBlock[], got ${typeof value}`);
  }
  for (const b of value) {
    if (typeof b !== 'object' || b === null || typeof (b as { type?: unknown }).type !== 'string') {
      throw new TypeError(`Expected ContentBlock with string .type, got ${JSON.stringify(b)}`);
    }
  }
}
