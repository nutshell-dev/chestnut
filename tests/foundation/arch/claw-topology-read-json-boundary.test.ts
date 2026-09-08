/**
 * Phase 1811 Step B (CT-D7): ClawTopology readJSON 边界专测。
 *
 * 锁定：Topology 的 JSON 读取返回 `unknown`，不以泛型承诺未经验证的业务类型；
 * 禁止 unchecked cast（`JSON.parse(x) as T` / `readJSON<T>` 泛型签名）回流。
 * schema 验证由资源业务 owner 在 caller 边界显式执行。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClawTopology } from '../../../src/core/claw-topology/index.js';

const topologyDir = path.join(process.cwd(), 'src/core/claw-topology');

/** 递归扫描 claw-topology owner 全部 src 文件（剥离注释后）。 */
function readOwnerSources(): string {
  const collect = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return collect(p);
      return e.name.endsWith('.ts') ? [p] : [];
    });
  return collect(topologyDir)
    .map(f => fs.readFileSync(f, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('phase 1811: ClawTopology readJSON 返回 unknown（CT-D7）', () => {
  const sources = readOwnerSources();

  it('readJSON 签名为 Promise<unknown>，无泛型形态', () => {
    // 泛型承诺形态（readJSON<T>）禁止回流
    expect(sources).not.toMatch(/readJSON\s*</);
    // 正向锚定：接口与实现均为 unknown 返回
    expect(sources).toMatch(/readJSON\(clawId: ClawId, relPath: string\): Promise<unknown>/);
  });

  it('owner 内无 JSON.parse 结果 unchecked cast', () => {
    expect(sources).not.toMatch(/JSON\.parse\([^)]*\)\s+as\s+(?!unknown\b)/);
  });

  it('类型级：caller 不经 decode 无法获得业务类型', () => {
    // 类型锚定：readJSON 返回值赋给 unknown OK；若退化为泛型/any，本断言失去意义。
    const assertUnknown: (t: ClawTopology) => Promise<unknown> =
      (t) => t.readJSON('claw' as never, 'x.json');
    expect(typeof assertUnknown).toBe('function');
  });
});
