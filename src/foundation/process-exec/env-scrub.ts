/**
 * @module L1.ProcessExec.EnvScrub
 * phase 346 B1 (review-2026-06-13): env allowlist for spawnDetached / exec.
 *
 * 应然：长跑子进程（daemon / watchdog / verifier subagent / exec tool）env
 * 不该 wholesale inherit parent's process.env。Parent 持任意 user-set 环境变量
 * 含 ssh-agent socket / arbitrary secret / 自定义 DEBUG flag。子进程 crash dump
 * / log / 其自身 spawn 子进程链可能泄漏其中任何一项。
 *
 * 应然 allowlist 覆盖：
 *  - 系统基本运行所需（PATH / HOME / SHELL / LANG / LC_*）
 *  - Node 运行时（NODE_*）
 *  - chestnut 自家变量（CHESTNUT_*）
 *  - 已知 LLM SDK 配置（API_KEY / AUTH_TOKEN / BASE_URL）
 *  - TLS / proxy 配置（HTTPS_PROXY / NODE_EXTRA_CA_CERTS）
 *
 * caller 可通过 allowExtra 显式注入额外允许的 key（debug flag 等）。
 */

const SYSTEM_BASE: ReadonlyArray<string> = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_TIME',
  'TZ', 'PWD',
];

const NODE_BASE: ReadonlyArray<string> = [
  'NODE_PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_NO_WARNINGS',
  'NODE_DEBUG', 'NODE_ENV',
  'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_PREFIX',
];

const TLS_PROXY: ReadonlyArray<string> = [
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
];

const LLM_API_KEYS: ReadonlyArray<string> = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  'GROQ_API_KEY', 'GROQ_BASE_URL',
  'XAI_API_KEY', 'XAI_BASE_URL',
  'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GROK_API_KEY',
  'MOONSHOT_API_KEY', 'KIMI_API_KEY',
  'MODELSCOPE_API_KEY',
  'SILICONFLOW_API_KEY',
  'VOLCENGINE_API_KEY',
];

const BASE_ALLOWLIST: ReadonlySet<string> = new Set([
  ...SYSTEM_BASE,
  ...NODE_BASE,
  ...TLS_PROXY,
  ...LLM_API_KEYS,
]);

const PREFIX_ALLOW: ReadonlyArray<string> = ['CHESTNUT_', 'VITEST_', 'LC_'];

export interface ScrubEnvOptions {
  /** Extra explicit key names to permit through scrub. */
  allowExtra?: ReadonlyArray<string>;
}

/**
 * Filter an env dict to allowlisted keys only.
 * Returns a new object; does not mutate input.
 *
 * Counted-out keys are dropped silently — by design, we don't want to log
 * env key names (some are themselves secrets / identifiers).
 */
export function scrubEnv(
  env: NodeJS.ProcessEnv,
  options: ScrubEnvOptions = {},
): Record<string, string | undefined> {
  const extras = new Set(options.allowExtra ?? []);
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (BASE_ALLOWLIST.has(key)) {
      result[key] = value;
      continue;
    }
    if (extras.has(key)) {
      result[key] = value;
      continue;
    }
    if (PREFIX_ALLOW.some(p => key.startsWith(p))) {
      result[key] = value;
      continue;
    }
  }
  return result;
}

/** Number of keys dropped by a scrub — for audit/observability. */
export function countScrubbed(
  env: NodeJS.ProcessEnv,
  options: ScrubEnvOptions = {},
): number {
  const before = Object.keys(env).filter(k => env[k] !== undefined).length;
  const after = Object.keys(scrubEnv(env, options)).length;
  return Math.max(0, before - after);
}
