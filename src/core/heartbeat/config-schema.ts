/**
 * Heartbeat config schema（phase 1870：字段声明归 Heartbeat owner）
 *
 * Owner: heartbeat（心跳启停/周期字段的业务业主）。
 * Composed by: src/assembly/config/compose-config.ts —— 合并进 root yaml `motion.*` 段
 * （字段路径保持 `motion.heartbeat_interval_ms`，无用户可见配置迁移）。
 *
 * 消费：Assembly 读 `globalConfig.motion.heartbeat_interval_ms` 后经构造参注入
 * （`createHeartbeat({ interval })`）；Heartbeat 模块内部不读全局配置。
 */
import { z } from 'zod';

/** 默认心跳间隔（ms）：0 = 禁用（省略等价于 0；随字段声明单源，init 模板引用）。 */
export const HEARTBEAT_DEFAULT_INTERVAL_MS = 0;

export const heartbeatConfigSchema = z.object({
  heartbeat_interval_ms: z.number().min(0).default(HEARTBEAT_DEFAULT_INTERVAL_MS),
});
