import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 614: invariant that every tsup config entry's src path exists on
 * disk AND every tsup build segment targets the same `node18` runtime.
 *
 * Rationale (ML#9 explicit coupling): tsup entry strings are file path
 * references — drift breaks invisibly:
 * - rename / move src file but forget to update tsup entry → tsup build
 *   fails with cryptic resolve error; CI may catch but local dev burns
 *   cycles before seeing it.
 * - inconsistent target across segments → one bundle uses ES2022 syntax,
 *   another uses ES2018; runtime polyfill behavior diverges, node-version
 *   compatibility unpredictable.
 *
 * Extends phase 613 (package.json ↔ tsup entry pairing) to verify the
 * src side of tsup config + cross-segment target uniformity.
 */
type TsupSeg = { entry: Record<string, string>; target?: string };

describe('tsup entry src + target uniformity invariant (phase 614)', () => {
  it('every tsup entry src exists + all segs target node18', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const tsupCfgPath = path.join(repoRoot, '.config/tsup.config.ts');
    const mod = (await import(tsupCfgPath)) as { default?: unknown };
    const raw = mod.default;
    const segs: TsupSeg[] = Array.isArray(raw) ? (raw as TsupSeg[]) : [];
    expect(segs.length).toBeGreaterThan(0);

    const REQUIRED_TARGET = 'node18';
    const offenders: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.target !== REQUIRED_TARGET) {
        offenders.push(`seg[${i}]: target=${String(seg.target)} (expected ${REQUIRED_TARGET})`);
      }
      for (const [name, srcPath] of Object.entries(seg.entry ?? {})) {
        const resolved = path.resolve(repoRoot, srcPath);
        if (!fs.existsSync(resolved)) {
          offenders.push(`seg[${i}].entry[${name}]: src ${srcPath} missing (resolved=${resolved})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
