/**
 * M14 inbox 文案：LLM 配置变更重载通知正文（单行常量，先例 M10 SYSTEM_MESSAGE_PREFIX）。
 * 触发/接收者：`chestnut config` 写盘后广播 → 各存活 claw daemon inbox（高优）。
 * 原 owner：cli/commands/config.ts（候选 claw 枚举、存活判断与投递仍归原 owner）。
 */

/* ------------------------------------------------------------------ */
/* phase 1909 Step B：配置重载通知正文迁入模板单源（机械迁移，逐字节不变）。*/
/* ------------------------------------------------------------------ */

/** LLM 配置变更重载通知正文。 */
export const CONFIG_RELOAD_NOTICE = 'LLM config changed on disk; please reload.';
