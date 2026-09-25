/**
 * M15 inbox 文案：用户长消息附件包装的系统行（viewport 用户输入 → claw inbox）。
 * 触发/接收者：chat viewport 提交超长用户消息 → 附件落盘后的 inbox 正文包装。
 * 原 owner：viewport/chat-viewport-utils.ts（附件落盘、路径解析、preview 截断与
 * 省略号渲染仍归原 owner——preview 是用户原文，不属于系统文案）。
 */

/* ------------------------------------------------------------------ */
/* phase 1909 Step B：附件包装系统行迁入模板单源（机械迁移，逐字节不变）；*/
/* 模板只收系统行要素与已渲染 preview，不拼接用户原文以外的东西。        */
/* ------------------------------------------------------------------ */

/** 用户附件包装最小呈现输入（preview 由调用方渲染后传入）。 */
export interface UserAttachmentInput {
  sizeChars: number;
  attachmentRelPath: string;
  previewHeadChars: number;
  /** 已渲染预览（截断长度与省略号由调用方决定，属业务分支）。 */
  preview: string;
}

/** 用户附件包装正文：系统行 + 原样透传的 preview。 */
export function userAttachmentBody(input: UserAttachmentInput): string {
  return [
    `[user-input attachment: ${input.sizeChars} chars]`,
    `path: ${input.attachmentRelPath}`,
    `preview (first ${input.previewHeadChars} chars):`,
    input.preview,
    '',
    'Use the read tool to fetch full or partial content (supports offset/limit).',
  ].join('\n');
}
