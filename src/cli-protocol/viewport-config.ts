/**
 * Chat-viewport config protocol / phase 1283 Step A
 * Owner: cli-protocol（viewport.* 配置协议业主：字段、校验与默认值）
 * Composed by: src/assembly/config/compose-config.ts (yaml `viewport.*` field)
 * Consumed by: CLIProcess motion / claw-chat（globalConfig.viewport）
 */
import { z } from 'zod';

/**
 * phase 142: 用户输入超此字符数 → 落盘到 inbox/attachments/、inbox body 改提示。
 * phase 1283 Step A: 默认值收敛为 CLIProtocol 自有的 viewport 配置协议事实，
 * 不再实时绑定 CommandTool 的 exec 输出截断阈值（两者职责独立、可独立变化）。
 */
export const VIEWPORT_USER_INPUT_INLINE_MAX_CHARS_DEFAULT = 2000;

export const viewportConfigSchema = z.object({
  show_recap_stream: z.boolean().default(false),
  show_system_messages: z.boolean().default(false),
  show_contract_events: z.boolean().default(true),
  trim_output_newlines: z.boolean().default(true),
  /**
   * 默认 VIEWPORT_USER_INPUT_INLINE_MAX_CHARS_DEFAULT (2000)。
   * caller 可在 chestnut.config.yaml 覆盖：
   *   viewport:
   *     user_input_inline_max_chars: 4000
   */
  user_input_inline_max_chars: z.number().int().positive()
    .default(VIEWPORT_USER_INPUT_INLINE_MAX_CHARS_DEFAULT),
});
