import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMModelNotFoundError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorBarrel from '../../../src/foundation/llm-orchestrator/index.js';
import {
  classifyLLMError,
  getUserActionHint,
} from '../../../src/foundation/llm-orchestrator/errors.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const sdkSource = readFileSync(
  new URL('../../../src/index.ts', import.meta.url),
  'utf8',
);

describe('LLMModelNotFoundError owner boundary', () => {
  it('is owned by LLMProvider and absent from both Orchestrator surfaces', () => {
    const error = new LLMModelNotFoundError('test-provider', 'missing-model');
    expect(error.code).toBe('LLM_MODEL_NOT_FOUND');
    expect('LLMModelNotFoundError' in orchestratorBarrel).toBe(false);
    expect('LLMModelNotFoundError' in orchestratorErrors).toBe(false);
  });

  it('keeps Orchestrator classification/hint while SDK aggregates owner directly', () => {
    const error = new LLMModelNotFoundError('test-provider', 'missing-model');
    expect(classifyLLMError(error)).toBe('permanent');
    expect(getUserActionHint(error)).toBe('switch_primary');
    expect(sdkSource).toMatch(
      /export\s*\{[^}]*LLMModelNotFoundError[^}]*\}\s*from\s*['"]\.\/foundation\/llm-provider\/index\.js['"]/s,
    );
  });
});
