/**
 * Phase 1925 Step C（设计稿 G4 门禁）：CJS 消费安全。
 *
 * pi-ai 无 CJS `require` 条件（exports 仅 import）——barrel/任何 L1 模块
 * 静态 import pi-ai 都会让 `require('chestnut')` 直接炸。因此 pi-ai 只经
 * 动态 import 触达（pi-ai-runtime.ts），本测试锁定该不变量：
 *
 * 1. dist 产物（index.cjs + index.js + chunks）源码扫描无静态 pi-ai 引入；
 * 2. `require(dist/index.cjs)` 真实加载成功（CJS 消费者入口不炸）。
 *
 * dist 新鲜度由 vitest globalSetup（phase 245/248）保证。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(__dirname, '../../..');
const distDir = path.join(repoRoot, 'dist');

/** 静态引入 pi-ai 的字面形态（CJS require / ESM static import）。 */
const STATIC_PI_AI_PATTERNS = [
  /require\(\s*['"]@earendil-works\/pi-ai/,
  /import\s+[^('"][^;]*from\s*['"]@earendil-works\/pi-ai/,
  /export\s+[^('"][^;]*from\s*['"]@earendil-works\/pi-ai/,
];

function collectDistJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectDistJs(full));
    else if (/\.(c?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('pi-ai CJS 消费安全（Phase 1925 Step C / G4）', () => {
  it('dist 产物无静态 pi-ai 引入（require/static import/export from）', () => {
    const files = collectDistJs(distDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of STATIC_PI_AI_PATTERNS) {
        expect(
          pattern.test(source),
          `${path.relative(repoRoot, file)} 含静态 pi-ai 引入（${pattern}）——pi-ai 只许动态 import`,
        ).toBe(false);
      }
    }
  });

  it('dist 产物含动态 import pi-ai（证明扫描模式有效、非 vacuous pass）', () => {
    const files = collectDistJs(distDir);
    const anyDynamic = files.some((file) =>
      /import\(\s*['"]@earendil-works\/pi-ai/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(anyDynamic).toBe(true);
  });

  it('require(dist/index.cjs) 加载成功且导出非空', () => {
    const cjsEntry = path.join(distDir, 'index.cjs');
    expect(fs.existsSync(cjsEntry)).toBe(true);
    const require = createRequire(path.join(repoRoot, 'package.json'));
    const mod = require(cjsEntry) as Record<string, unknown>;
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
