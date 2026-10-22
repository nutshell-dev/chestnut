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
  if (input.baseUrl) lines.push(`  Base URL: ${input.baseUrl}`);
  return lines;
}

export const SETUP_PROBE_FAILED_NOT_SAVED =
  'Provider was not saved because the connection check failed. Fix the credentials/endpoint and run the command again.';
