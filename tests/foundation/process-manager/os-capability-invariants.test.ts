import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const PM_ROOT = path.resolve(process.cwd(), 'src/foundation/process-manager');

function productionSources(): Array<{ file: string; source: string }> {
  return readdirSync(PM_ROOT)
    .filter(file => file.endsWith('.ts'))
    .map(file => ({
      file,
      source: readFileSync(path.join(PM_ROOT, file), 'utf8'),
    }));
}

describe('ProcessManager OS capability ownership (Phase 2141)', () => {
  it('does not call native process signalling or host query commands', () => {
    const offenders = productionSources().filter(({ source }) =>
      /process\.kill\(|\bspawnSync\(|\bexecFileSync\(|from ['"](?:node:)?child_process['"]/.test(source));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('keeps boolean probes and raw signal adapters at the L1 compatibility boundary', () => {
    const offenders = productionSources().filter(({ file, source }) =>
      file !== 'process-facts.ts' && file !== 'types.ts' && file !== 'manager.ts'
      && /ctx\.(?:l1IsAlive|kill)\b/.test(source));
    // Cleanup owners may only forward the injected L1 signal to L1 matching cleanup.
    const remaining = offenders.filter(({ file, source }) =>
      (file !== 'spawn.ts' && file !== 'orphan-cleanup.ts')
      || !/signal: ctx\.kill/.test(source) || /ctx\.l1IsAlive/.test(source));
    expect(remaining.map(({ file }) => file)).toEqual([]);
  });

  it('does not decode ps command text in ProcessManager', () => {
    const offenders = productionSources().filter(({ source }) =>
      /commandContainsDaemonDirToken|\.command\.split\(/.test(source));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});
