/**
 * phase 1864 Step I（CT-D12）架构锁：Topology 只消费最小事件 sink。
 *
 * - claw-topology 源码不依赖完整 AuditLog 面（无 import/标识）
 * - ClawTopologyDeps 持 optional `sink?: TopologyEventSink`
 * - write throw 语义显式（不吞观察失败）
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

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

describe('phase 1864 Step I (CT-D12): minimal TopologyEventSink', () => {
  it('claw-topology 源码无 AuditLog 依赖', () => {
    const offenders = walk(path.join(root, 'src', 'core', 'claw-topology'))
      .filter((file) => stripComments(fs.readFileSync(file, 'utf8')).includes('AuditLog'))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('ClawTopologyDeps 只持 optional sink（最小 write 形状）', () => {
    const types = stripComments(read('src/core/claw-topology/types.ts'));
    expect(types).toContain('sink?: TopologyEventSink');
    expect(types).toMatch(/export interface TopologyEventSink\s*\{[\s\S]*?write\(event: string, \.\.\.cols: \(string \| number\)\[\]\): void;/);
    // 语义注释显式：optional + write throw 传播
    const raw = read('src/core/claw-topology/types.ts');
    expect(raw).toContain('optional');
    expect(raw).toContain('传播');
  });
});
