import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const estimatorSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/token-estimator.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider single-message estimator deep surface', () => {
  it('keeps estimateMessageTokens local behind estimateMessagesTokens', () => {
    // phase 1800：Message 改名 ProviderWireMessage（wire 协议类型），本断言意图不变——
    // 单条估算不导出、messages 数组估算为唯一公开入口。
    expect(estimatorSource).not.toMatch(/export\s+function\s+estimateMessageTokens\s*\(/);
    expect(estimatorSource).toMatch(/(?:^|\n)(?:export\s+)?function\s+estimateMessageTokens\s*\(msg:\s*ProviderWireMessage\):\s*number\s*\{/);
    expect(estimatorSource).toMatch(/export\s+function\s+estimateMessagesTokens\s*\(messages:\s*readonly\s+ProviderWireMessage\[\]\):\s*number\s*\{/);
    expect(estimatorSource).toMatch(/for\s*\(const\s+msg\s+of\s+messages\)\s*\{\s*total\s*\+=\s*estimateMessageTokens\(msg\);/s);
  });
});
