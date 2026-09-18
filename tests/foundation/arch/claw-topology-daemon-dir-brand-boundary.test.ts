/**
 * phase 1864 Step D（CT-D4）架构锁：DaemonDir brand 构造归 ProcessManager。
 *
 * - Topology 只出位置事实（resolveClawDaemonDir = clawId → clawDir + PM adapter）
 * - src/core 不得直调 PM brand factory makeDaemonDir（构造唯 PM adapter）
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

/** 剥注释：只锁真实代码，不锁叙述。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('phase 1864 Step D (CT-D4): DaemonDir brand construction owned by PM', () => {
  it('src/core 无直接 makeDaemonDir brand 构造调用', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, 'src', 'core'))) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (/\bmakeDaemonDir\s*\(/.test(code)) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });

  it('topology daemon-dir 只解析位置、构造经 PM adapter', () => {
    const src = stripComments(read('src/core/claw-topology/daemon-dir.ts'));
    expect(src).toContain("makeDaemonDirFromLocation({ kind: 'local', clawDir })");
    expect(src).toMatch(/from\s+'\.\.\/\.\.\/foundation\/process-manager\/index\.js'/);
  });
});
