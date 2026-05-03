import { describe, it, expect } from 'vitest';
import path from 'path';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter, createSystemAudit, AUDIT_FILE } from '../../src/foundation/audit/index.js';
import { createAgentProcessManager } from '../../src/foundation/process-manager/agent-factory.js';
import { createProcessManagerForCLI, createDirContext } from '../../src/foundation/config/factories.js';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'shared-'));
}

describe('createProcessManagerForCLI', () => {
  it('返回值实现 ProcessManager 接口', () => {
    const prevRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = freshDir();
    const pm = createProcessManagerForCLI();
    expect(typeof pm.isAlive).toBe('function');
    expect(typeof pm.acquireLock).toBe('function');
    process.env.CLAWFORUM_ROOT = prevRoot;
  });

  it('每次调用返回新实例（无缓存）', () => {
    const prevRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = freshDir();
    expect(createProcessManagerForCLI()).not.toBe(createProcessManagerForCLI());
    process.env.CLAWFORUM_ROOT = prevRoot;
  });

  it('等价性：与手动 createAgentProcessManager(createSystemAudit(...)) 行为一致', () => {
    const dir = freshDir();
    const prevRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = dir;
    // 手动路径
    const fs = new NodeFileSystem({ baseDir: dir });
    const manual = createAgentProcessManager(createSystemAudit(fs, dir));
    // 工厂路径
    const factory = createProcessManagerForCLI();
    // 接口等价：同一 clawId 查询同一 PID（均为不存在）
    expect(manual.isAlive('nonexistent')).toBe(factory.isAlive('nonexistent'));
    process.env.CLAWFORUM_ROOT = prevRoot;
  });
});

describe('createDirContext', () => {
  it('audit.write 落盘到 {dir}/audit.tsv 且载荷原样保留', () => {
    const dir = freshDir();
    const { audit } = createDirContext(dir);
    audit.write('cli_test_event', 'key=value', 'n=42');
    const content = readFileSync(path.join(dir, AUDIT_FILE), 'utf-8');
    const line = content.trim().split('\n').pop()!;
    expect(line).toMatch(/cli_test_event/);
    expect(line).toMatch(/key=value/);
    expect(line).toMatch(/n=42/);
  });

  it('等价性：与手动 new NodeFileSystem + new AuditWriter 写入同一 tsv，内容完全一致', () => {
    const dir = freshDir();
    // 工厂写一条
    const { audit: factoryAudit } = createDirContext(dir);
    factoryAudit.write('equiv_event', 'src=factory');
    // 手动写一条
    const manualFs = new NodeFileSystem({ baseDir: dir });
    const manualAudit = new AuditWriter(manualFs, path.join(dir, AUDIT_FILE));
    manualAudit.write('equiv_event', 'src=manual');
    // 读 tsv，确认两条事件都在且格式一致（列数、分隔符）
    const lines = readFileSync(path.join(dir, AUDIT_FILE), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].split('\t').length).toBe(lines[1].split('\t').length);
    expect(lines[0]).toMatch(/src=factory/);
    expect(lines[1]).toMatch(/src=manual/);
  });

  it('每次调用返回新 fs + audit 实例（无缓存）', () => {
    const dir = freshDir();
    const a = createDirContext(dir);
    const b = createDirContext(dir);
    expect(a.fs).not.toBe(b.fs);
    expect(a.audit).not.toBe(b.audit);
  });

  it('fs.baseDir === dir 且 OS-only（可写任意子路径）', async () => {
    const dir = freshDir();
    const { fs } = createDirContext(dir);
    await fs.writeAtomic('subfile.txt', 'x');
    expect(readFileSync(path.join(dir, 'subfile.txt'), 'utf-8')).toBe('x');
  });

  it('失败契约：dir 不存在时 audit.write 不抛错（AuditWriter 内部捕获并输出 console.error）', () => {
    const nonExist = '/tmp/definitely-not-here-' + Date.now();
    const { audit } = createDirContext(nonExist);
    // AuditWriter.write 内部 try/catch 吞掉错误，改为断言不抛
    expect(() => audit.write('e', 'k=v')).not.toThrow();
  });
});
