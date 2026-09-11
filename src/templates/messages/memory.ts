/**
 * M09 inbox 文案：random dream 产出持久化完成通知。
 * 触发/接收者：Memory random-dream → motion inbox（random_dream_completed，normal）。
 * 原 owner：core/memory（投递状态机与 outbox 去重仍在 owner；deep-dream 模型正文不迁）。
 */

export function dreamOutputsPersistedMessage(outputCount: number, outputPath: string): string {
  return `Dream outputs persisted: ${outputCount} contracts. See ${outputPath}`;
}
