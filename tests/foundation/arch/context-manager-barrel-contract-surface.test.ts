import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('ContextManager barrel contract surface (phase 1861, CM-D9)', () => {
  const barrel = read('src/core/context_manager/index.ts');

  it('exports TrimAndPersist input contract (type-only)', () => {
    expect(barrel).toContain("type TrimAndPersistInputs");
    expect(barrel).toContain("type DialogStoreMutationCapability");
    expect(barrel).toContain("type TriggerKind");
  });

  it('exports trim policy contracts (type-only)', () => {
    expect(barrel).toContain("type TrimPolicy");
    expect(barrel).toContain("type TrimV2Options");
    expect(barrel).toContain('TrimRuntimePolicy');
    expect(barrel).toContain('MaybeTrimProactiveInputs');
  });

  it('exports typed error evidence contracts (type-only)', () => {
    expect(barrel).toContain("type ContextTrimExhaustedEvidence");
    expect(barrel).toContain("type ContextTrimPersistStage");
    expect(barrel).toContain('ContextTrimPersistError');
  });

  it('adds no new runtime value exports beyond the pre-phase surface', () => {
    const valueExports = [...barrel.matchAll(/^export \{([^}]*)\} from/gm)]
      .flatMap(m => m[1].split(','))
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('type '));
    expect(valueExports.sort()).toEqual([
      'CACHE_TTL_MS',
      'CONTEXT_TRIM_PREVIEW_BYTES',
      'CONTEXT_TRIM_RECENT_WINDOW_MS',
      'CONTEXT_TRIM_TARGET_RATIO',
      'ContextTrimExhaustedError',
      'ContextTrimPersistError',
      'REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO',
      'buildReactiveTrimPolicy',
      'maybeTrimProactive',
      'trimAndPersist',
    ]);
  });
});
