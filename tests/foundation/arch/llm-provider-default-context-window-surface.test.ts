import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(name: string): string {
  return readFileSync(
    new URL(`../../../src/foundation/llm-provider/${name}`, import.meta.url),
    'utf8',
  );
}

const windowOwner = source('model-context-windows.ts');
const runtime = readFileSync(
  new URL('../../../src/core/runtime/runtime.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider catalog identity and context window surface', () => {
  it('keeps heuristic/default fallback inside the window owner', () => {
    expect(windowOwner).not.toMatch(/export\s+const\s+DEFAULT_MODEL_CONTEXT_WINDOW\b/);
    expect(windowOwner).toMatch(/const\s+DEFAULT_MODEL_CONTEXT_WINDOW\s*=\s*256_000;/);
    expect(windowOwner).toMatch(/export\s+function\s+resolveContextWindowForIdentity\s*\(/);
    expect(runtime).not.toMatch(/resolveContextWindow/);
  });

  it.each([
    'config-adapter.ts',
    'pi-ai-model.ts',
    'pi-ai-endpoint.ts',
    'pi-ai-adapter.ts',
  ])('keeps generated catalog tables out of %s consumers', (name) => {
    const consumer = source(name);
    expect(consumer).not.toMatch(/import\s*\{[^}]*\bMODEL_CATALOG\b[^}]*\}\s*from/);
    expect(consumer).not.toMatch(/import\s*\{[^}]*\bPROVIDER_INVENTORY\b[^}]*\}\s*from/);
  });
});
