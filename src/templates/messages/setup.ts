/**
 * Phase 1972: 首次初始化 / provider add 的用户文案（层中性纯文本）。
 * 不包含 secret；keyRef 只允许 `${ENV}` 引用或 credential reference 文本。
 */

export const SETUP_WELCOME = 'Configure your LLM service for chestnut.\n';

export function setupProviderMenuLines(
  choices: readonly { label: string; description: string }[],
): string[] {
  return choices.map((choice, index) =>
    `${index + 1}. ${choice.label} — ${choice.description}`);
}

export const SETUP_OTHER_FORMAT_LINES = [
  'API format:',
  '1. Anthropic',
  '2. OpenAI',
  '3. Gemini',
];

export const SETUP_CANCELLED = 'Cancelled — no configuration was written.';

export interface SetupDraftPreviewInput {
  label: string;
  model: string;
  auth: string;
  role?: string;
  baseUrl?: string;
  keyRef?: string;
  /** Phase 1979: effective thinking（preset 默认）；固定服务为空、不显示。 */
  thinking?: string;
}

/** 脱敏预览：不打印明文 key，只显示引用/local/credential 说明。 */
export function setupDraftPreviewLines(input: SetupDraftPreviewInput): string[] {
  const lines = ['', 'Configuration preview:'];
  if (input.role) lines.push(`  Role:    ${input.role}`);
  lines.push(`  Service: ${input.label}`);
  lines.push(`  Auth:    ${input.auth}`);
  if (input.keyRef) {
    lines.push(`  API key: ${input.keyRef}`);
  }
  lines.push(`  Model:   ${input.model}`);
  if (input.thinking) lines.push(`  Thinking: ${input.thinking}`);
  if (input.baseUrl) lines.push(`  Base URL: ${input.baseUrl}`);
  return lines;
}

export const SETUP_PROBE_FAILED_NOT_SAVED =
  'Provider was not saved because the connection check failed. Fix the credentials/endpoint and run the command again.';

/** Phase 1976：单一 start 配置向导的阶段文案（失败后留在向导内修复）。 */
export function setupConnectingLine(label: string, model: string): string {
  return `Connecting to ${label} (${model})...`;
}

export const SETUP_CONFIRM_PROMPT = 'Continue with this configuration? [Y/n]';

export const SETUP_REPAIR_HEADING = 'LLM verification failed. Choose how to fix the configuration:';

export function setupRepairMenuLines(): string[] {
  return [
    '',
    SETUP_REPAIR_HEADING,
    '  1. Retry connection',
    '  2. Re-enter API key',
    '  3. Change model',
    '  4. Change service',
    '  n. Cancel start',
  ];
}

export const SETUP_ENDPOINTS_ALL_FAILED =
  'All endpoint candidates failed — configuration not saved.';

export function setupCredentialDiscardedLine(ref: string): string {
  return `Discarded unused credential \${${ref}} (setup was not committed).`;
}

export function setupCredentialCleanupFailedLine(ref: string, reason: string): string {
  return `⚠ Could not clean up unused credential \${${ref}}: ${reason}`;
}
