import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providerTypes = readFileSync(
  new URL('../../../src/foundation/llm-provider/types.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider Role deep surface', () => {
  it('keeps Role local to the wire message interface instead of exporting a standalone capability', () => {
    // phase 1800：Message 改名 ProviderWireMessage（chestnut 元数据归 DialogStore canonical
    // Message）；本断言意图不变——Role 不独立导出、只服务 wire message 接口。
    expect(providerTypes).not.toMatch(/export\s+type\s+Role\s*=/);
    expect(providerTypes).toMatch(/(?:^|\n)(?:export\s+)?type\s+Role\s*=\s*'user'\s*\|\s*'assistant'\s*\|\s*'system';/);
    expect(providerTypes).toMatch(/export\s+interface\s+ProviderWireMessage\s*\{[^}]*role:\s*Role;/s);
  });
});
