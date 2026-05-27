import { describe, it, expect } from 'vitest';
import { createLLMProviderSchema } from '../../../src/foundation/config/schemas.js';
import { REACT_DEFAULT_MAX_TOKENS } from '../../../src/core/step-executor/constants.js';

describe('phase 1286: max_tokens default raised to 1亿', () => {
  it('REACT_DEFAULT_MAX_TOKENS === 100_000_000', () => {
    expect(REACT_DEFAULT_MAX_TOKENS).toBe(100_000_000);
  });

  it('schema accepts max_tokens=100_000_000', () => {
    const schema = createLLMProviderSchema({ reactDefaultMaxTokens: REACT_DEFAULT_MAX_TOKENS });
    const r = schema.parse({ provider: 'kimi', model: 'kimi-k2.5', api_key: 'test-key', max_tokens: 100_000_000 });
    expect(r.max_tokens).toBe(100_000_000);
  });

  it('schema rejects max_tokens > 100_000_000', () => {
    const schema = createLLMProviderSchema({ reactDefaultMaxTokens: REACT_DEFAULT_MAX_TOKENS });
    expect(() => schema.parse({ provider: 'kimi', model: 'kimi-k2.5', api_key: 'test-key', max_tokens: 100_000_001 })).toThrow();
  });

  it('schema rejects max_tokens=0', () => {
    const schema = createLLMProviderSchema({ reactDefaultMaxTokens: REACT_DEFAULT_MAX_TOKENS });
    expect(() => schema.parse({ provider: 'kimi', model: 'kimi-k2.5', api_key: 'test-key', max_tokens: 0 })).toThrow();
  });

  it('schema applies default when max_tokens absent', () => {
    const schema = createLLMProviderSchema({ reactDefaultMaxTokens: REACT_DEFAULT_MAX_TOKENS });
    const r = schema.parse({ provider: 'kimi', model: 'kimi-k2.5', api_key: 'test-key' });
    expect(r.max_tokens).toBe(100_000_000);
  });
});
