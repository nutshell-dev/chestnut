/**
 * Test helper: build a fully-populated ClawGlobalConfig from a partial input.
 *
 * phase 12: after compose-config 改 .default({}) 单源、assemble.ts 直读 globalConfig.cron.jobs.<x>.schedule 等、
 * 测试 fixture 必须经 Zod parse 才能拿到 schema fills 后的完整 shape。本 helper 把 partial 输入交给 Zod parse、
 * 测试只需指定关心的字段、其他 cron job / section 由 schema defaults 自动填。
 */
import {
  createGlobalConfigSchema,
  type ClawGlobalConfig,
  type ClawGlobalConfigInput,
} from '../../src/assembly/config/compose-config.js';

export function buildTestGlobalConfig(partial: Partial<ClawGlobalConfigInput> = {}): ClawGlobalConfig {
  const llmDefault = {
    primary: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      api_key: 'test-key',
    },
  };
  const input: ClawGlobalConfigInput = {
    llm: partial.llm ?? llmDefault as ClawGlobalConfigInput['llm'],
    tool_timeout_ms: partial.tool_timeout_ms ?? 60_000,
    ...partial,
  };
  return createGlobalConfigSchema().parse(input);
}
