import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 629: invariant that tsup config:
 * - every segment has `sourcemap: true`
 * - the CLI-producing segment (entry contains key 'cli') has
 *   `banner.js === '#!/usr/bin/env node'`
 * - exactly one segment has `clean: true`
 *
 * Rationale:
 * - sourcemap on every seg → debug stack traces resolve to TS source
 *   uniformly. One seg lacking sourcemap → dist line numbers in that
 *   bundle's stack traces, harder to diagnose.
 * - CLI banner shebang → npm install -g + invoke `chestnut` requires
 *   shebang for the OS to dispatch to node. Missing shebang → bin file
 *   exists but doesn't execute.
 * - exactly-one clean → multiple `clean: true` segs race; later segs
 *   wipe earlier output, build emits empty dist.
 *
 * Pairs with phase 614 (tsup entry src + target), phase 613 (tsup ↔
 * package pairing), phase 612 (package entry points).
 */
type TsupSeg = {
  entry: Record<string, string>;
  sourcemap?: boolean;
  clean?: boolean;
  banner?: { js?: string };
};

describe('tsup CLI banner + sourcemap + clean invariant (phase 629)', () => {
  it('every seg sourcemap=true + CLI seg has shebang banner + exactly 1 clean', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/tsup.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    const segs: TsupSeg[] = Array.isArray(raw) ? (raw as TsupSeg[]) : [];
    expect(segs.length).toBeGreaterThan(0);

    const sourcemapOffenders: string[] = [];
    let cleanCount = 0;
    let cliSegFound = false;
    let cliBannerOk = false;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.sourcemap !== true) {
        sourcemapOffenders.push(`seg[${i}]: sourcemap=${String(seg.sourcemap)}`);
      }
      if (seg.clean === true) cleanCount += 1;
      if (seg.entry && 'cli' in seg.entry) {
        cliSegFound = true;
        cliBannerOk = seg.banner?.js === '#!/usr/bin/env node';
      }
    }
    expect(sourcemapOffenders).toEqual([]);
    expect(cleanCount).toBe(1);
    expect(cliSegFound).toBe(true);
    expect(cliBannerOk).toBe(true);
  });
});
