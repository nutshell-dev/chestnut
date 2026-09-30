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

describe('modify（Phase 1927 Step E：跨进程 RMW 事务）', () => {
  it('基本 RMW：fn 收到文件层当前值，返回新值原子写回（0600 不变）', async () => {
    const owner = makeOwner({});
    const seen = await owner.modify('K', async (current) => {
      expect(current).toBeUndefined();
      return 'v1';
    });
    expect(seen).toBe('v1');
    expect(makeOwner({}).resolve('K')).toEqual({ value: 'v1', source: 'file' });
    const again = await owner.modify('K', async (current) => {
      expect(current).toBe('v1'); // 锁内重读，非调用方旧快照
      return 'v2';
    });
    expect(again).toBe('v2');
    if (process.platform !== 'win32') {
      expect(fs.statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    }
  });

  it('fn 返回 undefined → 删除条目；缺席 ref 上删除为 no-op', async () => {
    const owner = makeOwner({});
    await owner.set('K', 'v');
    const deleted = await owner.modify('K', async () => undefined);
    expect(deleted).toBeUndefined();
    expect(makeOwner({}).resolve('K')).toBeUndefined();
    // 骨架保留（文件仍在）
    expect(fs.existsSync(credentialsFile())).toBe(true);
    // 文件从未存在时的删除：物化空骨架（与 unset 语义对齐——不炸）
    const home2 = createTrackedTempDirSync('chestnut-cred-home2-');
    vi.stubEnv('CHESTNUT_HOME', home2);
    await expect(makeOwner({}).modify('NOPE', async () => undefined)).resolves.toBeUndefined();
    vi.stubEnv('CHESTNUT_HOME', homeDir);
  });

  it('fn 返回相同值 → 跳过重写（文件不被替换）', async () => {
    const owner = makeOwner({});
    await owner.set('K', 'v');
    const before = fs.statSync(credentialsFile()).ino;
    const result = await owner.modify('K', async (current) => current);
    expect(result).toBe('v');
    expect(fs.statSync(credentialsFile()).ino).toBe(before); // 无原子发布
  });

  it('fn 抛错 → 不写回、原错误穿透', async () => {
    const owner = makeOwner({});
    await owner.set('K', 'v');
    const boom = new Error('refresh failed');
    await expect(owner.modify('K', async () => { throw boom; })).rejects.toBe(boom);
    expect(makeOwner({}).resolve('K')?.value).toBe('v');
  });

  it('空串返回值 → empty_value typed；env shadow → shadowed_by_env；非法 ref → invalid_ref', async () => {
    await expect(makeOwner({}).modify('K', async () => '')).rejects.toMatchObject({ code: 'empty_value' });
    await expect(makeOwner({ K: 'env' }).modify('K', async () => 'v'))
      .rejects.toMatchObject({ code: 'shadowed_by_env' });
    await expect(makeOwner({}).modify('1BAD', async () => 'v')).rejects.toMatchObject({ code: 'invalid_ref' });
  });

  it('锁竞争串行化：两 owner 并发 modify，迟到者读到先提交者的值（无 lost update）', async () => {
    // 真实文件锁（O_EXCL token）——锁机制进程无关，两实例等价两进程竞争。
    // 反向对照：若锁只包单次写而 fn 在锁外（Step E 前形态），B 的 fn 会在 A
    // 提交前以旧值并发执行，最终只剩一个提交（refresh 轮换 token 丢失场景）。
    const a = makeOwner({});
    const b = makeOwner({});
    await a.set('COUNTER', '0');
    const order: string[] = [];
    const increment = async (tag: string, current: string | undefined): Promise<string> => {
      order.push(`${tag}:saw:${current}`);
      // 持锁窗口：让并发的另一方必然先抵达锁等待（串行化证明不依赖时长）
      const LOCK_HOLD_WINDOW_MS = 50;
      await new Promise((res) => setTimeout(res, LOCK_HOLD_WINDOW_MS));
      return String(Number(current) + 1);
    };
    const [ra, rb] = await Promise.all([
      a.modify('COUNTER', (cur) => increment('a', cur)),
      b.modify('COUNTER', (cur) => increment('b', cur)),
    ]);
    // 两个提交都落地（1 与 2，次序不限）；后到者的 fn 看到的是先到者已提交的值
    expect([ra, rb].sort()).toEqual(['1', '2']);
    expect(order[0]).toBe(`${order[0]!.split(':')[0]}:saw:0`);
    expect(order[1]).toBe(`${order[1]!.split(':')[0]}:saw:1`);
    expect(makeOwner({}).resolve('COUNTER')?.value).toBe('2');
  });

  it('logout/login 交错：迟到 writer 不覆盖——delete 的 fn 看到并发 login 已提交的值', async () => {
    const login = makeOwner({});
    const logout = makeOwner({});
    const seenByLogout: (string | undefined)[] = [];
    const [loginResult] = await Promise.all([
      login.modify('PI_AI_CREDENTIAL_XAI', async (current) => {
        expect(current).toBeUndefined();
        // 持锁窗口：让 logout 抵达锁等待（证明其 fn 在 login 提交后执行）
        const LOGIN_HOLD_WINDOW_MS = 50;
        await new Promise((res) => setTimeout(res, LOGIN_HOLD_WINDOW_MS));
        return '{"type":"oauth","refresh":"r1"}';
      }),
      logout.modify('PI_AI_CREDENTIAL_XAI', async (current) => {
        seenByLogout.push(current);
        return undefined; // logout = 删除
      }),
    ]);
    expect(loginResult).toBe('{"type":"oauth","refresh":"r1"}');
    // 锁内重读：logout 的 fn 必然看到 login 提交的凭证（不是 undefined 旧快照）
    expect(seenByLogout).toEqual(['{"type":"oauth","refresh":"r1"}']);
    expect(makeOwner({}).resolve('PI_AI_CREDENTIAL_XAI')).toBeUndefined();
  });
});
