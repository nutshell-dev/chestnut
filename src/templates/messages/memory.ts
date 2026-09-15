/**
 * M09 inbox 文案：random dream 产出持久化完成通知。
 * 触发/接收者：Memory random-dream → motion inbox（random_dream_completed，normal）。
 * 原 owner：core/memory（投递状态机与 outbox 去重仍在 owner；deep-dream 模型正文不迁）。
 * phase 1835 信息契约：正文自含任务标识、输出块数、相对 motion 根的产物路径与
 * 按需读取用途；只陈述「输出块已保存」事实，不声称创建了契约、洞见已验证或
 * 已自动整理为可检索的长期记忆。owner 传最小持久事实，模板只呈现。
 */

export function dreamOutputsPersistedMessage(input: {
  readonly taskId: string;
  readonly outputCount: number;
  readonly outputPath: string;
}): string {
  return [
    '跨 claw 经验探索输出已保存。',
    `任务：${input.taskId}`,
    `产物：${input.outputCount} 个输出块`,
    `位置：motion 目录下的 ${input.outputPath}`,
    '',
    '这些内容来自对已归档契约的探索，尚未自动整理为可检索的长期记忆。',
    '需要参考这些经验时，可读取该文件，再判断哪些内容值得整理或采用。',
  ].join('\n');
}
