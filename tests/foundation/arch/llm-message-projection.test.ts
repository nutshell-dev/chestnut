/**
 * Phase 1800: LLM message wire/canonical 分层（Message 元数据耦合治理）。
 *
 * - llm-provider 不再声明含上层元数据的 Message；wire 类型 ProviderWireMessage 仅 role+content。
 * - canonical Message 归 DialogStore（origin/systemSubtype/addedAt/trimmed 唯一声明点）。
 * - provider 边界单向投影（sanitizeForLLMCall）运行时剥离元数据。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sanitizeForLLMCall } from '../../../src/foundation/llm-provider/sanitize.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { ProviderWireMessage } from '../../../src/foundation/llm-provider/index.js';

const TYPES_SRC = readFileSync(
  new URL('../../../src/foundation/llm-provider/types.ts', import.meta.url), 'utf8');
const CANONICAL_SRC = readFileSync(
  new URL('../../../src/foundation/dialog-store/canonical-message.ts', import.meta.url), 'utf8');

describe('llm message projection (phase 1800)', () => {
  it('llm-provider/types.ts 不再声明 Message；ProviderWireMessage 仅 role+content', () => {
    expect(TYPES_SRC).not.toMatch(/export\s+interface\s+Message\s*\{/);
    const m = TYPES_SRC.match(/export\s+interface\s+ProviderWireMessage\s*\{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    const body = m![1].replace(/\/\/[^\n]*/g, '');
    for (const meta of ['origin', 'systemSubtype', 'addedAt', 'trimmed']) {
      expect(body).not.toContain(meta);
    }
  });

  it('canonical Message 唯一声明点 = dialog-store/canonical-message.ts（4 元数据字段）', () => {
    const m = CANONICAL_SRC.match(/export\s+interface\s+Message\s+extends\s+ProviderWireMessage\s*\{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    for (const meta of ['origin?:', 'systemSubtype?:', 'addedAt?:', 'trimmed?:']) {
      expect(m![1]).toContain(meta);
    }
  });

  it('运行时投影：canonical Message 进、wire 出（元数据被剥离、role/content 不变）', () => {
    const canonical: Message = {
      role: 'user',
      content: 'hello',
      origin: 'system',
      systemSubtype: 'heartbeat',
      addedAt: '2026-09-07T00:00:00.000Z',
      trimmed: { trimmedAt: '2026-09-07T01:00:00.000Z', originalContentBytes: 1024 },
    };
    const wire: ProviderWireMessage[] = sanitizeForLLMCall([canonical]);
    expect(wire[0]).toEqual({ role: 'user', content: 'hello' });
    expect(Object.keys(wire[0]).sort()).toEqual(['content', 'role']);
    // caller 引用不被改写
    expect(canonical.origin).toBe('system');
  });
});
