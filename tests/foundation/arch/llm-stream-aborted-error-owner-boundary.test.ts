import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMStreamAbortedError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const orchestratorSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/orchestrator.ts', import.meta.url),
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
      /import\s*\{[^}]*LLMStreamAbortedError[^}]*\}\s*from\s*['"]\.\.\/llm-provider\/index\.js['"]/s,
    );
    expect(orchestratorSource).not.toMatch(
      /import\s*\{[^}]*LLMStreamAbortedError[^}]*\}\s*from\s*['"]\.\/errors\.js['"]/s,
    );
    expect(orchestratorSource.match(/new LLMStreamAbortedError\(/g)).toHaveLength(6);
  });
});
