import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
const { LLMEmptyResponseError } = llmProviderCall;
import * as orchestratorBarrel from '../../../src/foundation/llm-orchestrator/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const orchestratorSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/invocation-executor.ts', import.meta.url),
  'utf8',
);
const sdkSource = readFileSync(
  new URL('../../../src/index.ts', import.meta.url),
  'utf8',
);

describe('LLMEmptyResponseError owner boundary', () => {
  it('is owned by LLMProvider and absent from both Orchestrator surfaces', () => {
    const error = new LLMEmptyResponseError('test-provider');
    expect(error.code).toBe('LLM_EMPTY_RESPONSE');
    expect('LLMEmptyResponseError' in orchestratorBarrel).toBe(false);
    expect('LLMEmptyResponseError' in orchestratorErrors).toBe(false);
  });

  it('is consumed and aggregated directly from owner without losing construction sites', () => {
    expect(orchestratorSource).toMatch(
      /(?:import\s*\{[^}]*\bLLMEmptyResponseError\b[^}]*\}\s*from\s*['"][^'"]*llm-provider\/errors\.js['"]|import\s*\{\s*llmProviderCall\s*\}\s*from\s*['"][^'"]*llm-provider\/index\.js['"];\s*const\s*\{[^}]*\bLLMEmptyResponseError\b[^}]*\}\s*=\s*llmProviderCall)/s,
    );
    expect(orchestratorSource).not.toMatch(
      /import\s*\{[^}]*LLMEmptyResponseError[^}]*\}\s*from\s*['"]\.\/errors\.js['"]/s,
    );
    expect(orchestratorSource.match(/new LLMEmptyResponseError\(/g)).toHaveLength(2);
    expect(sdkSource).toMatch(
      /export\s*\{[^}]*LLMEmptyResponseError[^}]*\}\s*from\s*['"]\.\/foundation\/llm-provider\/index\.js['"]/s,
    );
  });
});
