/**
 * M04 inbox 文案：契约终态事件的外壳（标签 + claw + 已序列化数据）。
 * 触发/接收者：Assembly 契约通知 adapter → 本 daemon 自家 inbox（contract_events / contract_cancelled，高优）。
 * 原 owner：assembly（数据序列化与字段顺序仍归 adapter）。
 */

export function contractNotificationBody(label: string, clawId: string, serializedData: string): string {
  return `[${label}] claw=${clawId} ${serializedData}`;
}
