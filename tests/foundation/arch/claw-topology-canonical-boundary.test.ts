/**
 * Phase 1813 Step B (CT-D6): ClawTopology canonical containment 架构 ratchet。
 *
 * 锁定 topology owner 边界：
 * - read() 必须在词法 startsWith 之外持有 realpath canonical containment
 *   （禁止词法 guard 单独裁决的回退——symlink 外逃词法拦不住）；
 * - canonical 检查必须在实际读取之前（顺序锚定）；
 * - 外逃拒绝语义 'symlink escape' 经 CrossClawReadError 交付；
 * - Topology 不得反向依赖 Permissions 等上层/旁层模块（guard 归 owner 私有）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const topologyPath = path.join(process.cwd(), 'src/core/claw-topology', 'topology.ts');

/** 扫描前剥离注释：只锁定真实代码，不锁文档叙述。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('phase 1813 (CT-D6): claw-topology canonical boundary', () => {
  const topology = stripComments(fs.readFileSync(topologyPath, 'utf8'));

  it('read() 持有 realpath canonical containment（词法 guard 不得单独裁决）', () => {
    // 词法第一门（'..' 穿越）保留
    expect(topology).toMatch(/startsWith\(clawspaceRoot\)/);
    // canonical 第二门：双端 realpath + 前缀比对
    expect(topology).toMatch(/fs\.realpath\(/);
    expect(topology).toMatch(/targetReal\s*!==\s*clawspaceReal\s*&&\s*!targetReal\.startsWith\(clawspaceReal\s*\+\s*path\.sep\)/);
  });

  it('canonical 检查在 fs.read 之前、外逃经 CrossClawReadError 拒绝', () => {
    const canonicalIdx = topology.indexOf('fs.realpath(');
    const readIdx = topology.indexOf('fs.read(absPath)');
    expect(canonicalIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(-1);
    expect(canonicalIdx).toBeLessThan(readIdx);
    expect(topology).toContain(`new CrossClawReadError(clawId, relPath, 'symlink escape')`);
  });

  it('ENOENT 透传语义保留（isFileNotFound 分支存在，不以 escape 误报缺文件）', () => {
    expect(topology).toMatch(/isFileNotFound\(err\)/);
  });

  it('Topology 不反向依赖 Permissions/上层模块（guard 归 owner 私有）', () => {
    expect(topology).not.toMatch(/from\s+['"][^'"]*permissions[^'"]*['"]/);
    expect(topology).not.toMatch(/from\s+['"][^'"]*assembly[^'"]*['"]/);
  });
});
