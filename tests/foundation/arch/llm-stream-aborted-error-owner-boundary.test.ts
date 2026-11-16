import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
const { LLMStreamAbortedError } = llmProviderCall;
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const orchestratorSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/invocation-executor.ts', import.meta.url),
  'utf8',
);

describe('LLMStreamAbortedError owner boundary', () => {
  it('is owned by LLMProvider and absent from the Orchestrator deep surface', () => {
    const error = new LLMStreamAbortedError('test-provider', 'test-reason');
    expect(error.code).toBe('LLM_STREAM_ABORTED');
    expect(error.message).toContain('test-reason');
    expect('LLMStreamAbortedError' in orchestratorErrors).toBe(false);
  });

  it('is consumed directly from the owner barrel without losing construction sites', () => {
    expect(orchestratorSource).toMatch(
      /(?:import\s*\{[^}]*\bLLMStreamAbortedError\b[^}]*\}\s*from\s*['"][^'"]*llm-provider\/errors\.js['"]|import\s*\{\s*llmProviderCall\s*\}\s*from\s*['"][^'"]*llm-provider\/index\.js['"];\s*const\s*\{[^}]*\bLLMStreamAbortedError\b[^}]*\}\s*=\s*llmProviderCall)/s,
    );
    expect(orchestratorSource).not.toMatch(
      /import\s*\{[^}]*LLMStreamAbortedError[^}]*\}\s*from\s*['"]\.\/errors\.js['"]/s,
    );
    // Phase 2058 移除重复 breaker 记账后，错误仍在各实际失败出口构造，共 5 处。
    expect(orchestratorSource.match(/new LLMStreamAbortedError\(/g)).toHaveLength(5);
  });
});
