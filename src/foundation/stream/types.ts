/**
 * Stream module types (L2)
 */

/**
 * stream.jsonl 写入接口（由 StreamWriter 结构兼容，无需 implements 声明）
 */
export interface StreamLog {
  write(event: { ts: number; type: string; [key: string]: unknown }): void;
}
