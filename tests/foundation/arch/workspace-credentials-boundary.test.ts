import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkTsFiles } from './cli-guidance-boundary-helpers.js';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_ROOTS = [
  path.join(PROJECT_ROOT, 'src', 'core', 'llm-configuration'),
  path.join(PROJECT_ROOT, 'src', 'assembly'),
];
const FORBIDDEN_SOURCE_RE = /\bCHESTNUT_HOME\b|\bos\.homedir\s*\(|\bgetUserDotEnvPath\b|\bgetCredentialsHome\b|['"]user-env['"]/;

function offendersIn(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n')
    .flatMap((line, index) => FORBIDDEN_SOURCE_RE.test(line) ? [`${file}:${index + 1}`] : []);
}

describe('Phase 2206 workspace credentials boundary', () => {
  it('L4 与 Assembly 不重新引入用户级凭据路径、来源或 home override', () => {
    const offenders = SCAN_ROOTS.flatMap(root => walkTsFiles(root).flatMap(offendersIn));
    expect(offenders).toEqual([]);
  });

  it('反向 fixture：扫描器能识别旧环境来源与 home 路径回退', () => {
    expect(FORBIDDEN_SOURCE_RE.test('process.env.CHESTNUT_HOME')).toBe(true);
    expect(FORBIDDEN_SOURCE_RE.test("return os.homedir() + '/.chestnut'")).toBe(true);
    expect(FORBIDDEN_SOURCE_RE.test("source: 'user-env'")).toBe(true);
    expect(FORBIDDEN_SOURCE_RE.test("source: 'project-env'")).toBe(false);
  });
});
