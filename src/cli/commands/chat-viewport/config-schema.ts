/**
 * Chat-viewport config schema / phase 10 decentralize
 * Owner: cli/chat-viewport（用户视图渲染开关 yaml schema 业主）
 * Composed by: src/assembly/compose-config.ts (yaml `viewport.*` field)
 */
import { z } from 'zod';
import { EXEC_MAX_OUTPUT } from '../../../foundation/command-tool/index.js';

export const viewportConfigSchema = z.object({
  show_recap_stream: z.boolean().default(false),
  show_system_messages: z.boolean().default(false),
  show_contract_events: z.boolean().default(true),
  trim_output_newlines: z.boolean().default(true),
  /**
   * phase 142: 用户输入超此字符数 → 落盘到 inbox/attachments/、inbox body 改提示。
   * 默认 EXEC_MAX_OUTPUT (2000、与 chestnut "信息流入 motion" 标准一致)。
   * caller 可在 chestnut.config.yaml 覆盖：
   *   viewport:
   *     user_input_inline_max_chars: 4000
   */
  user_input_inline_max_chars: z.number().int().positive().default(EXEC_MAX_OUTPUT),
});

export type ViewportConfig = z.infer<typeof viewportConfigSchema>;
