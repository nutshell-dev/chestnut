import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 656: invariant that:
 * - library seg (entry contains 'index') has `splitting: false`
 *   → defends against chunking; produces single dist/index.js (package.json
 *     main points at single file)
 * - CLI seg (entry contains 'cli') has `minify: false`
 *   → preserves function names + readable stack traces for debug
 *
 * Rationale:
 * - splitting=true on library seg → output splits into chunks (dist/
 *   index.js + chunks/_*.js); package.json `main: ./dist/index.cjs`
 *   still points at single file but require() at runtime fails to
 *   resolve the chunks → broken package install
 * - minify=true on CLI seg → CLI runtime errors show `a`/`b`/`c`
 *   function names in stack trace; debugging in user terminals becomes
 *   guesswork
 *
 * Pairs with phase 614 (tsup entry src + target), phase 629 (CLI
 * banner/sourcemap/clean), phase 630 (library dts+format).
 */
type TsupSeg = {
  entry: Record<string, string>;
  splitting?: boolean;
  minify?: boolean;
};

describe('tsup splitting + minify invariant (phase 656)', () => {
  it('library seg splitting=false + CLI seg minify=false', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/tsup.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    const segs: TsupSeg[] = Array.isArray(raw) ? (raw as TsupSeg[]) : [];
    expect(segs.length).toBeGreaterThan(0);

    const librarySeg = segs.find(s => s.entry && 'index' in s.entry);
    const cliSeg = segs.find(s => s.entry && 'cli' in s.entry);

    expect(librarySeg, 'library seg with entry index missing').toBeDefined();
    expect(cliSeg, 'CLI seg with entry cli missing').toBeDefined();

    expect((librarySeg as TsupSeg).splitting).toBe(false);
    expect((cliSeg as TsupSeg).minify).toBe(false);
  });
});
