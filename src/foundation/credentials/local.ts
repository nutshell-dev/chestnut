/**
 * @module L2a.Credentials
 * @layer L2 基础层
 *
 * 本地 Credentials owner 实现（Phase 1925 Step B）。
 *
 * 分层解析（首个非空命中胜出，空值处处视为缺席）：
 *   进程环境（只读、最高）> 用户级凭据文件（唯一可写层）
 *   > 项目 .env（只读回退）> 用户级 .env（只读回退）。
 *
 * 写入纪律：
 * - 凭据文件 0600、凭据根目录 0700（Windows 跳过 chmod 与权限断言）；
 * - 读路径发现 group/other 权限位（mode & 0o077）→ typed 'permissions' loud 抛错；
 * - 写一律「跨进程锁 + 锁内重读 + 原子发布」（锁复用 ConfigStore
 *   withYamlConfigLock，锁文件为 credentials.yaml.lock）。
 *
 * resolve/describe 同步、每次调用重读文件不缓存；set/unset 异步。
 * describe 永不返回 secret 值。
 */

import * as path from 'path';
import * as yaml from 'js-yaml';
import type { FileSystem } from '../fs/index.js';
import { withYamlConfigLock, withYamlConfigLockAsync } from '../config-store/index.js';
import type {
  CredentialInfo,
  CredentialsOwner,
  ResolvedCredential,
} from './types.js';
import { isCredentialRefName } from './types.js';
import { CredentialsError } from './errors.js';
import {
  getCredentialsFilePath,
  getProjectDotEnvPath,
  getUserDotEnvPath,
} from './paths.js';
import { parseDotEnv } from './dotenv.js';

export interface LocalCredentialsDeps {
  fsFactory: (baseDir: string) => FileSystem;
  /** 进程环境层（缺省 process.env；测试可注入隔离环境）。 */
  env?: NodeJS.ProcessEnv;
}

/** 凭据文件顶层结构契约：{version: 1, refs: {NAME: value}}。 */
const CREDENTIALS_FILE_VERSION = 1;
const CREDENTIALS_FILE_ALLOWED_KEYS = new Set(['version', 'refs']);

/** 模块私有 unknown error 单行格式化（同 ConfigStore 先例）。 */
function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const head = error.message || error.name || 'Error';
    return code ? `[${code}] ${head}` : head;
  }
  return String(error);
}

function assertValidRefName(ref: string): void {
  if (!isCredentialRefName(ref)) {
    throw new CredentialsError(
      'invalid_ref',
      `Invalid credential ref name: ${JSON.stringify(ref)} ` +
      `(must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
    );
  }
}

/** 非空判定：空值处处视为缺席。 */
function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

export function createLocalCredentials(deps: LocalCredentialsDeps): CredentialsOwner {
  const env = deps.env ?? process.env;

  /** 绝对路径 → 该目录 scoped FileSystem + basename（path guard 兼容）。 */
  function fsFor(absPath: string): { fs: FileSystem; basename: string } {
    return { fs: deps.fsFactory(path.dirname(absPath)), basename: path.basename(absPath) };
  }

  /**
   * 权限断言（POSIX）：group/other 权限位 → typed 'permissions' loud 抛错，
   * 消息自带修复建议。Windows 跳过（无 POSIX 权限语义）。
   */
  function assertSecureMode(fs: FileSystem, basename: string, absPath: string): void {
    if (process.platform === 'win32') return;
    const mode = fs.statSync(basename).mode;
    if ((mode & 0o077) !== 0) {
      throw new CredentialsError(
        'permissions',
        `Credentials file ${absPath} is readable by group/other ` +
        `(mode ${(mode & 0o777).toString(8).padStart(4, '0')}). Fix with: chmod 600 ${absPath}`,
      );
    }
  }

  /**
   * 读取凭据文件 refs（文件不存在 → 空）。解析严格：未知顶层键 / version !== 1 /
   * refs 非 object / 值非字符串 → typed 'io_error' loud。空字符串值保留给上层
   * 按「空值缺席」语义跳过。
   */
  function readRefs(): Record<string, string> {
    const credentialsPath = getCredentialsFilePath();
    const { fs, basename } = fsFor(credentialsPath);
    if (!fs.existsSync(basename)) return {};

    assertSecureMode(fs, basename, credentialsPath);

    let content: string;
    try {
      content = fs.readSync(basename);
    } catch (err) {
      throw new CredentialsError(
        'io_error',
        `Failed to read credentials file ${credentialsPath}: ${formatUnknownError(err)}`,
        { cause: err },
      );
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch (err) {
      throw new CredentialsError(
        'io_error',
        `Invalid YAML in credentials file ${credentialsPath}: ${formatUnknownError(err)}`,
        { cause: err },
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CredentialsError(
        'io_error',
        `Invalid credentials file ${credentialsPath}: expected {version: 1, refs: {...}}`,
      );
    }
    const doc = parsed as Record<string, unknown>;
    for (const key of Object.keys(doc)) {
      if (!CREDENTIALS_FILE_ALLOWED_KEYS.has(key)) {
        throw new CredentialsError(
          'io_error',
          `Invalid credentials file ${credentialsPath}: unknown top-level key ${JSON.stringify(key)}`,
        );
      }
    }
    if (doc.version !== CREDENTIALS_FILE_VERSION) {
      throw new CredentialsError(
        'io_error',
        `Invalid credentials file ${credentialsPath}: expected version ${CREDENTIALS_FILE_VERSION}`,
      );
    }
    if (doc.refs === undefined) return {};
    if (typeof doc.refs !== 'object' || doc.refs === null || Array.isArray(doc.refs)) {
      throw new CredentialsError(
        'io_error',
        `Invalid credentials file ${credentialsPath}: refs must be a map of name → string`,
      );
    }
    const refs: Record<string, string> = {};
    for (const [name, value] of Object.entries(doc.refs as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new CredentialsError(
          'io_error',
          `Invalid credentials file ${credentialsPath}: value of ${JSON.stringify(name)} must be a string`,
        );
      }
      refs[name] = value;
    }
    return refs;
  }

  /** 读取 .env 回退层（文件不存在 → 空；读失败 → typed 'io_error' loud）。 */
  function readDotEnvLayer(absPath: string): Record<string, string> {
    const { fs, basename } = fsFor(absPath);
    if (!fs.existsSync(basename)) return {};
    let content: string;
    try {
      content = fs.readSync(basename);
    } catch (err) {
      throw new CredentialsError(
        'io_error',
        `Failed to read dotenv file ${absPath}: ${formatUnknownError(err)}`,
        { cause: err },
      );
    }
    return parseDotEnv(content);
  }

  /** 分层查找：首个非空命中胜出。 */
  function lookup(ref: string): ResolvedCredential | undefined {
    const envValue = env[ref];
    if (present(envValue)) return { value: envValue, source: 'env' };

    const fileValue = readRefs()[ref];
    if (present(fileValue)) return { value: fileValue, source: 'file' };

    const projectValue = readDotEnvLayer(getProjectDotEnvPath())[ref];
    if (present(projectValue)) return { value: projectValue, source: 'project-env' };

    const userValue = readDotEnvLayer(getUserDotEnvPath())[ref];
    if (present(userValue)) return { value: userValue, source: 'user-env' };

    return undefined;
  }

  /** 锁内重读 + 变换 + 原子发布 + 0600（目录确保 0700）。 */
  async function mutateRefsLocked(mutator: (refs: Record<string, string>) => void): Promise<void> {
    const credentialsPath = getCredentialsFilePath();
    const { fs } = fsFor(credentialsPath);
    fs.ensureDirSync('.');
    if (process.platform !== 'win32') {
      fs.chmodSync('.', 0o700);
    }
    await withYamlConfigLock({ fsFactory: deps.fsFactory }, credentialsPath, () => {
      const refs = readRefs();
      mutator(refs);
      const content = yaml.dump({ version: CREDENTIALS_FILE_VERSION, refs });
      fs.writeAtomicSync(path.basename(credentialsPath), content);
      if (process.platform !== 'win32') {
        fs.chmodSync(path.basename(credentialsPath), 0o600);
      }
    });
  }

  return {
    resolve(ref: string): ResolvedCredential | undefined {
      assertValidRefName(ref);
      return lookup(ref);
    },

    describe(ref: string): CredentialInfo {
      assertValidRefName(ref);
      const hit = lookup(ref);
      if (!hit) {
        // 完全未配置（env 必无 shadow，否则已命中 env 层）→ 可写
        return { configured: false, writable: true };
      }
      // writable 仅当命中唯一可写层；env shadow / 只读回退层均不可写
      return { configured: true, source: hit.source, writable: hit.source === 'file' };
    },

    async set(ref: string, value: string): Promise<void> {
      assertValidRefName(ref);
      if (value === '') {
        throw new CredentialsError(
          'empty_value',
          `Refusing to store empty value for credential ref ${ref} (empty means absent)`,
        );
      }
      if (present(env[ref])) {
        throw new CredentialsError(
          'shadowed_by_env',
          `Credential ref ${ref} is already provided by the process environment; ` +
          `storing a file value would have no effect (env wins). Unset the env var first.`,
        );
      }
      await mutateRefsLocked((refs) => {
        refs[ref] = value;
      });
    },

    async unset(ref: string): Promise<void> {
      assertValidRefName(ref);
      if (present(env[ref])) {
        throw new CredentialsError(
          'shadowed_by_env',
          `Credential ref ${ref} is provided by the process environment; ` +
          `removing the file value would have no effect (env wins). Unset the env var first.`,
        );
      }
      // 缺席 no-op：文件不存在或 ref 不在文件中
      const credentialsPath = getCredentialsFilePath();
      const { fs, basename } = fsFor(credentialsPath);
      if (!fs.existsSync(basename)) return;
      if (!(ref in readRefs())) return;
      await mutateRefsLocked((refs) => {
        delete refs[ref];
      });
    },

    async modify(
      ref: string,
      fn: (current: string | undefined) => Promise<string | undefined>,
    ): Promise<string | undefined> {
      assertValidRefName(ref);
      if (present(env[ref])) {
        throw new CredentialsError(
          'shadowed_by_env',
          `Credential ref ${ref} is already provided by the process environment; ` +
          `modifying the file value would have no effect (env wins). Unset the env var first.`,
        );
      }
      const credentialsPath = getCredentialsFilePath();
      const { fs } = fsFor(credentialsPath);
      fs.ensureDirSync('.');
      if (process.platform !== 'win32') {
        fs.chmodSync('.', 0o700);
      }
      // Phase 1927 Step E：完整 RMW 闭包在跨进程锁内（含 fn 的 refresh/login 决策，
      // 可为 async 网络调用）。锁内重读保证 fn 看到的是最新提交；fn 抛错不写回。
      return withYamlConfigLockAsync({ fsFactory: deps.fsFactory }, credentialsPath, async () => {
        const refs = readRefs();
        const current = present(refs[ref]) ? refs[ref] : undefined;
        const next = await fn(current);
        if (next === '') {
          throw new CredentialsError(
            'empty_value',
            `Refusing to store empty value for credential ref ${ref} (empty means absent)`,
          );
        }
        if (next === current) return next; // 无变化不重写（避免无谓原子发布）
        if (next === undefined) {
          delete refs[ref];
        } else {
          refs[ref] = next;
        }
        const content = yaml.dump({ version: CREDENTIALS_FILE_VERSION, refs });
        fs.writeAtomicSync(path.basename(credentialsPath), content);
        if (process.platform !== 'win32') {
          fs.chmodSync(path.basename(credentialsPath), 0o600);
        }
        return next;
      });
    },
  };
}
