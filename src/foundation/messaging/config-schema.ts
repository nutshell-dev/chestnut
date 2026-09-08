/**
 * Messaging config schema / phase 1820（message-size-env-bypass）
 * Owner: messaging（writer wire-size 上限字段业主）
 * Composed by: src/assembly/config/compose-config.ts (yaml `messaging.*` field)
 *
 * 此前 inbox/outbox writer 各自直接读 process.env.CHESTNUT_*_BODY_MAX_BYTES 并
 * 持有重复默认值——绕过 ConfigStore 与装配注入。现配置 owner（本 schema）持有默认值，
 * assembly 装配期注入 writer；writer 只消费数值。env 覆盖整体废止（config 层无读
 * env 先例；两 env 变量零测试零文档锁定）。
 */
import { z } from 'zod';

/** wire-size 上限默认值：64 KiB（原 inbox/outbox writer 内重复常量的单源化，数值不变）。 */
export const MESSAGING_BODY_MAX_BYTES_DEFAULT = 64 * 1024;

export const messagingConfigSchema = z.object({
  /** inbox/outbox wire 载荷（body + metadata + extraFields）统一硬上限（bytes）。 */
  body_max_bytes: z.number().int().positive().default(MESSAGING_BODY_MAX_BYTES_DEFAULT),
});

/** writer 构造期注入的最小 limits capability——Messaging 只消费数值。 */
export interface MessagingWriterLimits {
  readonly bodyMaxBytes: number;
}

/**
 * 默认 limits 实例：仅 messaging 模块内 ad-hoc writer（notify/DLQ 等无 config 通路的
 * 旁路写）与测试 fixture 使用；生产主链路 writer 由 assembly 注入 globalConfig 值。
 */
export const MESSAGING_WRITER_LIMITS_DEFAULT: MessagingWriterLimits = {
  bodyMaxBytes: MESSAGING_BODY_MAX_BYTES_DEFAULT,
};
