/**
 * M19 提示词片段：status 工具输出尾段的 motion CLI 提示字面。
 * 触发/接收者：status 工具 execute（motion claw）→ 工具返回值尾段
 * 「CLI hints for motion」（composer 拼 binary 后由 status 工具附加）。
 * 原 owner：core/status-service/motion-guidance.ts（facts 结构与尾段组装）
 * 与 assembly/motion-guidance-composer.ts（binary 拼接）——结构与组装职责
 * 仍归原 owner；字面归本目录单源。
 */

/* ------------------------------------------------------------------ */
/* phase 1909 Step C：verb 片段/purpose/note/段头/binary 字面迁入模板    */
/* 单源（机械迁移，逐字节不变）；facts 组装、binary 拼接、尾段行序留在    */
/* 原 owner（字段名与顺序不动）。                                        */
/* ------------------------------------------------------------------ */

/** status 工具输出尾段段头。 */
export const MOTION_GUIDANCE_CLI_HINTS_HEADING = '[CLI hints for motion]';

/** motion guidance invocation 的 CLI binary 字面（composer 拼在 verb 片段前）。 */
export const MOTION_GUIDANCE_CLI_BINARY = 'chestnut';

/** status 工具相关 verb 字面（fragment + purpose）；facts 结构组装仍归 status-service owner。 */
export const MOTION_STATUS_GUIDANCE_VERBS = [
  {
    fragment: 'claw <name> status',
    purpose: '查看其他 claw 当前 contract / tasks / storage 业务态',
  },
  {
    fragment: 'claw list',
    purpose: '列出所有 claw 加 name + alive 状态、辅助选 <name>',
  },
] as const;

/** 尾段 note：说明该组 CLI 命令的用途与观察范围。 */
export const MOTION_STATUS_GUIDANCE_NOTE = 'motion 用 status 工具查自己状态后，可通过下列 CLI 命令查其他 claw 的业务态（in-process status 工具仅观察自己）';

/** 尾段命令行：完整 invocation + purpose。 */
export function motionGuidanceCommandLine(invocation: string, purpose: string): string {
  return `- ${invocation} — ${purpose}`;
}
