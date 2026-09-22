import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// phase 1900: 配置面进入编译期保护——`.config/**/*.ts` 由 `.config/tsconfig.json`
// 纳入 `pnpm typecheck`。本守卫防止覆盖率被后来的改动悄悄摘掉（tsconfig 被删、
// include 被收窄、exclude 排除问题文件、package.json 挂钩被摘）。

const configTsconfigUrl = new URL('../../../.config/tsconfig.json', import.meta.url);
const configDirUrl = new URL('../../../.config/', import.meta.url);
const packageJsonUrl = new URL('../../../package.json', import.meta.url);

function readJsonc(url: URL): Record<string, unknown> {
  const text = readFileSync(url, 'utf8')
    // 块注释剥离需跳过字符串字面量（'./**/*.ts' 内含 /* */ 序列，盲剥会吃掉 include 值）
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g, '$1')
    .replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(text) as Record<string, unknown>;
}

function listConfigTsFiles(dir: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const sub of listConfigTsFiles(new URL(`${entry.name}/`, dir))) {
        out.push(`${entry.name}/${sub}`);
      }
    } else if (entry.name.endsWith('.ts')) {
      out.push(entry.name);
    }
  }
  return out;
}

describe('config typecheck coverage invariant (Phase 1900)', () => {
  it('.config/tsconfig.json exists and covers all .config TS files', () => {
    const cfg = readJsonc(configTsconfigUrl);
    const include = cfg.include as string[];
    expect(include).toContain('./**/*.ts');

    const tsFiles = listConfigTsFiles(configDirUrl);
    expect(tsFiles.length).toBeGreaterThan(0);
    // include 为 './**/*.ts' 时，.config 下任何 .ts 文件均被覆盖（防新文件漏检）。
    for (const file of tsFiles) {
      expect(file).toMatch(/\.ts$/);
    }
  });

  it('.config/tsconfig.json is check-only and cannot silently exclude files', () => {
    const cfg = readJsonc(configTsconfigUrl);
    const compilerOptions = cfg.compilerOptions as Record<string, unknown>;
    expect(compilerOptions.noEmit).toBe(true);
    expect(cfg.exclude).toEqual([]);
  });

  it('package.json typecheck runs the config tsconfig', () => {
    const pkg = readJsonc(packageJsonUrl);
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.typecheck).toContain('-p .config/tsconfig.json');
  });
});
