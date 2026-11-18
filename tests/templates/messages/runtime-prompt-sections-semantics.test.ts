/**
 * phase 1909 Step C（M16）：runtime 提示词段字面语义验收。
 * Phase 2193 C1：Active Contract 段与 checkbox 模板已退役，只保留 Memory 段头。
 */

import { describe, it, expect } from 'vitest';
import { MEMORY_SECTION_HEADING } from '../../../src/templates/messages/index.js';

describe('phase 1909: runtime 提示词段字面（M16）', () => {
  it('保留 Memory 段头字面', () => {
    expect(MEMORY_SECTION_HEADING).toBe('## Memory');
  });
});
