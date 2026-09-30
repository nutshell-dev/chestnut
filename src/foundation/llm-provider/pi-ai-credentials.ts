/**
 * @module L1.LLMProvider.PiAi
 *
 * pi-ai CredentialStore 桥接（Phase 1926 Step D；Phase 1927 Step E 边界重构）。
 *
 * pi-ai 的 OAuth/api_key stored credential 生命周期（login 写入、refresh 锁内
 * 轮换、logout 删除）需要一个 app-owned CredentialStore；pi-ai 缺省是
 * InMemoryCredentialStore（进程退出即丢，refresh 轮换的 token 会丢失）——不可用。
 *
 * Phase 1927 Step E 边界（F4 修复）：
 * - 本模块只做**类型适配**（pi-ai CredentialStore ↔ L1 字符串 KV 接缝 +
 *   provider ref 映射 + JSON 编解码），不持有任何全局/模块级可变状态；
 * - `PiAiCredentialBackend.modify` 是完整跨进程 RMW 事务（由装配根以
 *   Credentials owner 的锁内 modify 实现）——read→refresh/login 决策→写/删
 *   全部在 owner 锁内，迟到 writer 不可能覆盖另一进程的提交；
 * - CredentialStore 实例由装配根（Assembly/CLI）创建并经实例依赖注入
 *   （createPiAiEndpoint options / Models 构造），backend 在 store 生命周期内
 *   固定，不因另一次 config load 改变。
 *
 * secret 仍归 Credentials owner：不进 YAML 配置、不进 audit/log（ref 名与
 * JSON 值只经 owner 链路）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import { LLMError } from './errors.js';
import { PROVIDER_INVENTORY } from './provider-inventory.generated.js';

/**
 * L1-owned 字符串 KV 接缝（由装配根以 Credentials owner 实现）。
 * modify 是唯一写路径（跨进程事务）；delete 经 modify(ref, () => undefined) 表达。
 */
export interface PiAiCredentialBackend {
  read(ref: string): Promise<string | undefined>;
  modify(
    ref: string,
    fn: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined>;
}

/** pi-ai CredentialStore 的本地别名（orchestrator/装配注入面引用，不直触 pi-ai 类型）。 */
export type PiAiCredentialStore = PiAi.CredentialStore;

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
 * 构造 pi-ai CredentialStore——backend 在构造时固定注入（store 生命周期内不漂移）。
 *
 * 串行化：全部写路径（modify/delete）经 backend.modify——Credentials owner 的
 * 跨进程锁内 RMW 事务，read→fn→write/delete 整体串行（同进程与跨进程同一把
 * 文件锁；pi-ai 的 OAuth refresh 闭包在锁内执行）。
 */
export function createPiAiCredentialStore(backend: PiAiCredentialBackend): PiAi.CredentialStore {
  return {
    async read(providerId) {
      const raw = await backend.read(piAiCredentialRef(providerId));
      return raw === undefined ? undefined : parseCredential(providerId, raw);
    },
    async list() {
      // owner 无枚举接口：以 catalog provider id 集为探测域逐个 read（list 仅用于
      // 状态枚举，非常态路径）；不执行任何 api-key command（本 store 无 command 语义）。
      const infos: PiAi.CredentialInfo[] = [];
      for (const providerId of CATALOG_PROVIDER_IDS) {
        const raw = await backend.read(piAiCredentialRef(providerId));
        if (raw === undefined) continue;
        const credential = parseCredential(providerId, raw);
        infos.push({ providerId, type: credential.type });
      }
      return infos;
    },
    async modify(providerId, fn) {
      let captured: PiAi.Credential | undefined;
      await backend.modify(piAiCredentialRef(providerId), async (raw) => {
        const current = raw === undefined ? undefined : parseCredential(providerId, raw);
        const next = await fn(current);
        captured = next ?? current;
        // pi-ai 契约：fn 返回 undefined = 不变更（返回原值，owner 层跳过重写）；
        // 删除只经 delete()（→ owner.modify(ref, () => undefined)）。
        return next === undefined ? raw : JSON.stringify(next);
      });
      return captured;
    },
    async delete(providerId) {
      await backend.modify(piAiCredentialRef(providerId), async () => undefined);
    },
  };
}
