/**
 * Phase 1926 Step D：pi-ai provider 登录/登出运行缝（CLI 唯一入口）。
 *
 * `Models.login` 是 pi-ai 唯一受支持的登录入口（OAuth device_code / auth_url /
 * manual_code 与 api_key 交互流）；凭证由 pi-ai 自动经 CredentialStore 持久化——
 * 本仓桥接到用户级 Credentials owner（见 pi-ai-credentials.ts），secret 不进
 * YAML/audit/log。Phase 1927 Step E：CredentialStore 由调用方显式注入（装配根
 * 经 createUserPiAiCredentialStore 固定创建），本模块不持任何全局状态。
 *
 * 本模块独立成缝：`config provider login/logout` 与 init OAuth 引导共用；
 * 测试 mock 本模块即可覆盖 CLI 编排（不 mock pi-ai 本身）。
 */

import * as readline from 'readline';
import type * as PiAi from '@earendil-works/pi-ai';
import { loadPiAiRuntime, type PiAiCredentialStore } from '../foundation/llm-provider/index.js';
import { CliError } from './errors.js';
import { passwordQuestion } from './utils/password-prompt.js';

export type ProviderLoginType = 'oauth' | 'api_key';

/** 解析目标 provider 的可用登录方式（CLI 提示与 --type 校验共用）。 */
export async function providerLoginTypes(piAiProvider: string): Promise<ProviderLoginType[]> {
  const runtime = await loadPiAiRuntime();
  const provider = runtime.builtinProviders().find((p) => p.id === piAiProvider);
  if (!provider) {
    throw new CliError(`Unknown pi-ai provider "${piAiProvider}" (not in builtin catalog)`);
  }
  const types: ProviderLoginType[] = [];
  if (provider.auth.oauth) types.push('oauth');
  // ambient-only provider（无 login 的 apiKey auth，如纯环境解析）不提供 api_key 登录
  if (provider.auth.apiKey?.login) types.push('api_key');
  return types;
}

/** readline 上的 AuthInteraction（prompt 四型 + notify 事件呈现；不含 secret 回显）。 */
function createReadlineInteraction(rl: readline.Interface): PiAi.AuthInteraction {
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, (ans) => resolve(ans.trim())));
  return {
    async prompt(prompt) {
      switch (prompt.type) {
        case 'secret':
          return passwordQuestion(rl, `${prompt.message}: `);
        case 'select': {
          console.log(prompt.message);
          prompt.options.forEach((opt, i) => {
            console.log(`${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
          });
          const raw = await question('> ');
          const idx = parseInt(raw, 10) - 1;
          const picked = prompt.options[idx];
          if (!picked) throw new CliError('Invalid selection');
          return picked.id;
        }
        case 'manual_code':
        case 'text':
        default:
          return question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ''}: `);
      }
    },
    notify(event) {
      switch (event.type) {
        case 'auth_url':
          console.log(`\nOpen this URL to authorize:\n  ${event.url}`);
          if (event.instructions) console.log(event.instructions);
          break;
        case 'device_code':
          console.log(`\nDevice authorization:`);
          console.log(`  Code: ${event.userCode}`);
          console.log(`  URL:  ${event.verificationUri}`);
          if (event.expiresInSeconds) console.log(`  (expires in ${event.expiresInSeconds}s)`);
          break;
        case 'info': {
          const links = event.links?.map((l) => `  ${l.label ? `${l.label}: ` : ''}${l.url}`) ?? [];
          console.log([event.message, ...links].join('\n'));
          break;
        }
        case 'progress':
          console.log(event.message);
          break;
      }
    },
  };
}

/**
 * 交互登录并把凭证持久化到用户级 Credentials owner。
 * 成功打印来源标签（不含 secret）；失败 loud 上抛（CliError / pi-ai ModelsError）。
 */
export async function runProviderLogin(opts: {
  piAiProvider: string;
  type: ProviderLoginType;
  /** Phase 1927 Step E：装配根固定创建的 CredentialStore（显式注入）。 */
  credentials: PiAiCredentialStore;
  /** 测试/调用方注入 readline（缺省自建并负责关闭）。 */
  rl?: readline.Interface;
}): Promise<void> {
  const runtime = await loadPiAiRuntime();
  const provider = runtime.builtinProviders().find((p) => p.id === opts.piAiProvider);
  if (!provider) {
    throw new CliError(`Unknown pi-ai provider "${opts.piAiProvider}" (not in builtin catalog)`);
  }
  if (opts.type === 'oauth' && !provider.auth.oauth) {
    throw new CliError(`Provider "${opts.piAiProvider}" has no OAuth login (api_key only)`);
  }
  if (opts.type === 'api_key' && !provider.auth.apiKey?.login) {
    throw new CliError(
      `Provider "${opts.piAiProvider}" has no interactive api_key login ` +
      `(ambient-only: configure environment per its auth hint instead)`,
    );
  }

  const ownRl = opts.rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const models = runtime.createModels({ credentials: opts.credentials });
    models.setProvider(provider);
    await models.login(opts.piAiProvider, opts.type, createReadlineInteraction(ownRl));
    console.log(`✓ Logged in to ${provider.name} (${opts.type}); credential stored in user credentials file`);
  } finally {
    if (!opts.rl) ownRl.close();
  }
}

/** 登出：删除 stored credential（OAuth/api_key 同一存储）。 */
export async function runProviderLogout(opts: {
  piAiProvider: string;
  /** Phase 1927 Step E：装配根固定创建的 CredentialStore（显式注入）。 */
  credentials: PiAiCredentialStore;
}): Promise<void> {
  const runtime = await loadPiAiRuntime();
  const models = runtime.createModels({ credentials: opts.credentials });
  const provider = runtime.builtinProviders().find((p) => p.id === opts.piAiProvider);
  if (!provider) {
    throw new CliError(`Unknown pi-ai provider "${opts.piAiProvider}" (not in builtin catalog)`);
  }
  models.setProvider(provider);
  await models.logout(opts.piAiProvider);
  console.log(`✓ Logged out from ${provider.name} (stored credential removed)`);
}
