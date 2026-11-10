import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkTsFiles } from './cli-guidance-boundary-helpers.js';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const MODULE_ROOT = path.join(SRC_ROOT, 'core', 'llm-configuration');
const OLD_CREDENTIALS_ROOT = path.join(SRC_ROOT, 'foundation', 'credentials');

function importTargets(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function upperLayerImports(file: string): string[] {
  return importTargets(file).filter((specifier) => {
    if (!specifier.startsWith('.')) return false;
    const resolved = path.resolve(path.dirname(file), specifier);
    return resolved.startsWith(path.join(SRC_ROOT, 'assembly') + path.sep)
      || resolved.startsWith(path.join(SRC_ROOT, 'cli') + path.sep);
  });
}

describe('Phase 2097: LLMConfiguration 物理边界', () => {
  it('旧 credentials 生产入口消失，生产源码不再引用旧路径', () => {
    expect(fs.existsSync(OLD_CREDENTIALS_ROOT)).toBe(false);
    const offenders = walkTsFiles(SRC_ROOT).filter((file) =>
      importTargets(file).some((specifier) => specifier.includes('foundation/credentials')),
    );
    expect(offenders).toEqual([]);
  });

  it('L4 模块不反向依赖 Assembly 或 CLI', () => {
    const offenders = walkTsFiles(MODULE_ROOT).flatMap((file) =>
      upperLayerImports(file).map((specifier) => `${path.relative(PROJECT_ROOT, file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('Assembly 不转发兼容认证存储工厂', () => {
    const barrel = fs.readFileSync(path.join(SRC_ROOT, 'assembly', 'index.ts'), 'utf8');
    expect(barrel).not.toContain('createUserPiAiCredentialStore');
    expect(barrel).not.toContain('createLegacyAuthenticationStore');
  });

  it('反向 fixture：扫描器能识别上层相对导入', () => {
    const fixture = path.join(MODULE_ROOT, 'authentication-store.ts');
    expect(upperLayerImports(fixture)).toEqual([]);
    const text = fs.readFileSync(fixture, 'utf8');
    expect(/from\s*['"]\.\.\/\.\.\/assembly\/index\.js['"]/.test(text)).toBe(false);
    expect(path.resolve(path.dirname(fixture), '../../assembly/index.js'))
      .toBe(path.join(SRC_ROOT, 'assembly', 'index.js'));
  });
});
