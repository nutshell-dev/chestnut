/**
 * @module L1.LLMProvider.PiAi
 *
 * pi-ai CredentialStore 桥接（Phase 1926 Step D）。
 *
 * pi-ai 的 OAuth/api_key stored credential 生命周期（login 写入、refresh 锁内
 * 轮换、logout 删除）需要一个 app-owned CredentialStore；pi-ai 缺省是
 * InMemoryCredentialStore（进程退出即丢，refresh 轮换的 token 会丢失）——不可用。
 *
 * 本模块提供两级接缝：
 * 1. `PiAiCredentialBackend` —— 纯字符串 KV（L1 不知 L2a Credentials 业务概念，
 *    与 AuditSink 同纪律的 duck-typed 界面）；
 * 2. `registerPiAiCredentialBackend` —— 装配根（assembly/config-load，每次
 *    loadGlobalConfig）把用户级 Credentials owner（~/.chestnut/credentials.yaml，
 *    0600）适配为 backend 并注册。secret 仍归 Credentials owner：不进 YAML
 *    配置、不进 audit/log（ref 名与 JSON 值只经 owner 链路）。
 *
 * 未注册时：read 一律 undefined（视为无 stored credential，ambient/env 路径
 * 不受影响），写/删 loud 抛错（OAuth login 不会被静默丢凭证）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import { LLMError } from './errors.js';
import { PROVIDER_INVENTORY } from './provider-inventory.generated.js';

/** L1-owned 字符串 KV 接缝（由装配根以 Credentials owner 实现）。 */
export interface PiAiCredentialBackend {
  read(ref: string): Promise<string | undefined>;
  write(ref: string, value: string): Promise<void>;
  remove(ref: string): Promise<void>;
}

/**
 * provider id → Credentials owner ref 名（环境变量命名约定，isCredentialRefName
 * 合法）：非字母数字折叠为 '_'、大写、PI_AI_CREDENTIAL_ 前缀。
 */
export function piAiCredentialRef(providerId: string): string {
  const sanitized = providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return `PI_AI_CREDENTIAL_${sanitized}`;
}

/** catalog 内全部 provider id（list() 探测集；源自生成快照，不触 pi-ai 运行时）。 */
const CATALOG_PROVIDER_IDS: readonly string[] = Object.freeze(Object.keys(PROVIDER_INVENTORY));

let activeBackend: PiAiCredentialBackend | undefined;

/**
 * 装配根注册凭据后端（重复注册以后者为准——同一进程同一 owner，幂等）。
 * 传 undefined 复位（测试用）。
 */
export function registerPiAiCredentialBackend(backend: PiAiCredentialBackend | undefined): void {
  activeBackend = backend;
}

/** 当前已注册的 backend（诊断/测试用）。 */
export function getPiAiCredentialBackend(): PiAiCredentialBackend | undefined {
  return activeBackend;
}

function requireBackend(): PiAiCredentialBackend {
  if (!activeBackend) {
    throw new LLMError(
      'pi-ai credential backend is not registered: stored credentials (OAuth login / refresh) ' +
      'require the user-level credentials file. This process loaded no global config ' +
      '(registration happens on config load).',
      { field: 'credentialBackend' },
    );
  }
  return activeBackend;
}

function parseCredential(providerId: string, raw: string): PiAi.Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LLMError(
      `Stored credential for provider "${providerId}" is corrupted (not JSON); ` +
      `remove ref ${piAiCredentialRef(providerId)} from the user credentials file and login again.`,
      { provider: providerId, cause: err },
    );
  }
  const type = (parsed as { type?: unknown } | null)?.type;
  if (type !== 'api_key' && type !== 'oauth') {
    throw new LLMError(
      `Stored credential for provider "${providerId}" has unknown type ${JSON.stringify(type)}; ` +
      `remove ref ${piAiCredentialRef(providerId)} from the user credentials file and login again.`,
      { provider: providerId },
    );
  }
  return parsed as PiAi.Credential;
}

/**
 * 构造 pi-ai CredentialStore（进程级单例经 getPiAiCredentialStore）。
 * backend 在每次调用时动态解析——注册发生在 store 创建之后也生效（装配根
 * 注册时机不约束 endpoint 构造顺序）。
 *
 * 串行化：modify/delete 按 provider id 进程内 promise 链互斥（pi-ai 的 OAuth
 * refresh 在 modify 锁内执行，不得并发双写）；跨进程序列化由 Credentials
 * owner set/unset 自身的跨进程锁保证。
 */
export function createPiAiCredentialStore(): PiAi.CredentialStore {
  const chains = new Map<string, Promise<unknown>>();
  const serialize = <T>(providerId: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(providerId) ?? Promise.resolve()).then(fn, fn);
    chains.set(providerId, next.catch(() => {
      // silent: 链上 rejection 由调用方接收；此处仅防止链本身成为 unhandled
    }));
    return next;
  };

  return {
    async read(providerId) {
      const raw = await activeBackend?.read(piAiCredentialRef(providerId));
      return raw === undefined ? undefined : parseCredential(providerId, raw);
    },
    async list() {
      // owner 无枚举接口：以 catalog provider id 集为探测域逐个 read（list 仅用于
      // 状态枚举，非常态路径）；不执行任何 api-key command（本 store 无 command 语义）。
      const infos: PiAi.CredentialInfo[] = [];
      if (!activeBackend) return infos;
      for (const providerId of CATALOG_PROVIDER_IDS) {
        const raw = await activeBackend.read(piAiCredentialRef(providerId));
        if (raw === undefined) continue;
        const credential = parseCredential(providerId, raw);
        infos.push({ providerId, type: credential.type });
      }
      return infos;
    },
    modify(providerId, fn) {
      return serialize(providerId, async () => {
        const backend = requireBackend();
        const ref = piAiCredentialRef(providerId);
        const raw = await backend.read(ref);
        const current = raw === undefined ? undefined : parseCredential(providerId, raw);
        const next = await fn(current);
        if (next === undefined) return undefined;
        await backend.write(ref, JSON.stringify(next));
        return next;
      });
    },
    async delete(providerId) {
      await serialize(providerId, async () => {
        await requireBackend().remove(piAiCredentialRef(providerId));
      });
    },
  };
}

let storeSingleton: PiAi.CredentialStore | undefined;

/** 进程级 CredentialStore 单例（endpoint 构造与 login 命令共用同一存储视图）。 */
export function getPiAiCredentialStore(): PiAi.CredentialStore {
  storeSingleton ??= createPiAiCredentialStore();
  return storeSingleton;
}
