/**
 * Phase 1925 Step B: 用户级 Credentials owner 行为测试。
 *
 * 冻结契约：分层优先级（env > file > project-env > user-env）、空值缺席、
 * describe 不返回值、set/unset 0600/0700 与锁内重读、shadowed 拒绝、
 * 权限位 loud、invalid file loud、外部编辑下一次 resolve 可见。
 * 全部经 CHESTNUT_HOME / CHESTNUT_ROOT stubEnv 隔离，不触碰真实 home。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  createLocalCredentials,
  isCredentialsError,
  isCredentialRefName,
  CredentialsError,
} from '../../../src/foundation/credentials/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let homeDir: string;
let projectDir: string;

function makeOwner(env?: NodeJS.ProcessEnv) {
  return createLocalCredentials({ fsFactory, ...(env ? { env } : {}) });
}

function credentialsFile(): string {
  return path.join(homeDir, 'credentials.yaml');
}

function writeCredentialsFile(content: string, mode = 0o600): void {
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(credentialsFile(), content, { mode });
}

beforeEach(() => {
  homeDir = createTrackedTempDirSync('chestnut-cred-home-');
  projectDir = createTrackedTempDirSync('chestnut-cred-proj-');
  vi.stubEnv('CHESTNUT_HOME', homeDir);
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isCredentialRefName', () => {
  it('接受环境变量命名约定、拒绝非法名', () => {
    expect(isCredentialRefName('ANTHROPIC_API_KEY')).toBe(true);
    expect(isCredentialRefName('_X1')).toBe(true);
    expect(isCredentialRefName('1ABC')).toBe(false);
    expect(isCredentialRefName('MY-VAR')).toBe(false);
    expect(isCredentialRefName('')).toBe(false);
  });
});

describe('resolve 分层优先级', () => {
  it('env > file > project-env > user-env', () => {
    writeCredentialsFile('version: 1\nrefs:\n  K: file-value\n');
    fs.writeFileSync(path.join(projectDir, '.env'), 'K=project-value\n');
    fs.writeFileSync(path.join(homeDir, '.env'), 'K=user-value\n');

    // 无 env → file 胜出
    expect(makeOwner({}).resolve('K')).toEqual({ value: 'file-value', source: 'file' });
    // env 注入 → env 胜出（最高优先）
    expect(makeOwner({ K: 'env-value' }).resolve('K')).toEqual({ value: 'env-value', source: 'env' });
  });

  it('file 缺席时 project-env 胜出；project-env 缺席时 user-env 兜底', () => {
    fs.writeFileSync(path.join(projectDir, '.env'), 'P=project-value\n');
    fs.writeFileSync(path.join(homeDir, '.env'), 'U=user-value\nP=project-shadowed\n');
    expect(makeOwner({}).resolve('P')).toEqual({ value: 'project-value', source: 'project-env' });
    expect(makeOwner({}).resolve('U')).toEqual({ value: 'user-value', source: 'user-env' });
  });

  it('空值处处视为缺席', () => {
    writeCredentialsFile('version: 1\nrefs:\n  K: ""\n');
    fs.writeFileSync(path.join(homeDir, '.env'), 'K=user-value\n');
    expect(makeOwner({ K: '' }).resolve('K')).toEqual({ value: 'user-value', source: 'user-env' });
    expect(makeOwner({}).resolve('MISSING')).toBeUndefined();
  });

  it('外部编辑在下一次 resolve 可见（无缓存）', () => {
    writeCredentialsFile('version: 1\nrefs:\n  K: v1\n');
    const owner = makeOwner({});
    expect(owner.resolve('K')?.value).toBe('v1');
    writeCredentialsFile('version: 1\nrefs:\n  K: v2\n');
    expect(owner.resolve('K')?.value).toBe('v2');
  });

  it('非法 ref 名抛 invalid_ref', () => {
    expect(() => makeOwner({}).resolve('1BAD')).toThrowError(CredentialsError);
    try {
      makeOwner({}).resolve('1BAD');
      expect.unreachable();
    } catch (err) {
      expect(isCredentialsError(err) && err.code).toBe('invalid_ref');
    }
  });
});

describe('describe', () => {
  it('只返回 configured/source/writable，不返回值', () => {
    writeCredentialsFile('version: 1\nrefs:\n  K: secret-value\n');
    const info = makeOwner({}).describe('K');
    expect(info).toEqual({ configured: true, source: 'file', writable: true });
    expect(JSON.stringify(info)).not.toContain('secret-value');
  });

  it('env 命中 writable=false；未配置 writable=true', () => {
    expect(makeOwner({ K: 'v' }).describe('K')).toEqual({ configured: true, source: 'env', writable: false });
    expect(makeOwner({}).describe('NOPE')).toEqual({ configured: false, writable: true });
    fs.writeFileSync(path.join(projectDir, '.env'), 'P=v\n');
    expect(makeOwner({}).describe('P')).toEqual({ configured: true, source: 'project-env', writable: false });
  });
});

describe('set/unset', () => {
  it('set 落盘 0600、目录 0700，配置引用可解析', async () => {
    const owner = makeOwner({});
    await owner.set('MY_KEY', 'sk-test-value');
    expect(owner.resolve('MY_KEY')).toEqual({ value: 'sk-test-value', source: 'file' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(credentialsFile()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(homeDir).mode & 0o777).toBe(0o700);
    }
    // 文件骨架合法
    const content = fs.readFileSync(credentialsFile(), 'utf8');
    expect(content).toContain('version: 1');
    expect(content).not.toContain('process.env');
  });

  it('set 拒绝空值（empty_value）', async () => {
    await expect(makeOwner({}).set('K', '')).rejects.toMatchObject({ code: 'empty_value' });
  });

  it('set/unset 被 env shadow 时拒绝（shadowed_by_env）', async () => {
    const owner = makeOwner({ K: 'env-value' });
    await expect(owner.set('K', 'v')).rejects.toMatchObject({ code: 'shadowed_by_env' });
    await expect(owner.unset('K')).rejects.toMatchObject({ code: 'shadowed_by_env' });
    expect(fs.existsSync(credentialsFile())).toBe(false);
  });

  it('unset 缺席 no-op；set 后 unset 移除条目保留骨架', async () => {
    const owner = makeOwner({});
    await owner.unset('NOPE'); // 文件不存在 — no-op
    expect(fs.existsSync(credentialsFile())).toBe(false);
    await owner.set('A', '1');
    await owner.set('B', '2');
    await owner.unset('A');
    expect(owner.resolve('A')).toBeUndefined();
    expect(owner.resolve('B')).toEqual({ value: '2', source: 'file' });
  });

  it('两个 owner 实例交错 set 不丢更新（锁内重读）', async () => {
    const a = makeOwner({});
    const b = makeOwner({});
    await Promise.all([
      a.set('K1', 'v1'), b.set('K2', 'v2'),
      a.set('K3', 'v3'), b.set('K4', 'v4'),
    ]);
    const owner = makeOwner({});
    for (const [k, v] of [['K1', 'v1'], ['K2', 'v2'], ['K3', 'v3'], ['K4', 'v4']] as const) {
      expect(owner.resolve(k)?.value).toBe(v);
    }
  });

  it('非法 ref 名 set/unset 抛 invalid_ref', async () => {
    await expect(makeOwner({}).set('1BAD', 'v')).rejects.toMatchObject({ code: 'invalid_ref' });
    await expect(makeOwner({}).unset('1BAD')).rejects.toMatchObject({ code: 'invalid_ref' });
  });
});

describe('权限与文件合法性（POSIX）', () => {
  it.skipIf(process.platform === 'win32')('凭据文件带 group/other 权限位 → permissions loud', () => {
    writeCredentialsFile('version: 1\nrefs:\n  K: v\n', 0o644);
    try {
      makeOwner({}).resolve('K');
      expect.unreachable();
    } catch (err) {
      expect(isCredentialsError(err)).toBe(true);
      expect((err as CredentialsError).code).toBe('permissions');
      expect((err as Error).message).toContain('chmod 600');
    }
  });

  it('结构非法（version 缺失/未知键/refs 非 map/值非 string）→ io_error loud', () => {
    const cases = [
      'refs:\n  K: v\n',                       // version 缺失
      'version: 2\nrefs:\n  K: v\n',           // version 错
      'version: 1\nrefs:\n  K: v\nextra: 1\n', // 未知顶层键
      'version: 1\nrefs: not-a-map\n',         // refs 非 map
      'version: 1\nrefs:\n  K: 42\n',          // 值非 string
    ];
    for (const content of cases) {
      writeCredentialsFile(content);
      expect(() => makeOwner({}).resolve('K')).toThrowError(CredentialsError);
    }
  });

  it('YAML 语法损坏 → io_error loud', () => {
    writeCredentialsFile('version: 1\nrefs:\n  K: "unterminated\n');
    expect(() => makeOwner({}).resolve('K')).toThrowError(CredentialsError);
  });
});
