/**
 * Cron config schema / phase 10 decentralize
 * Owner: cron（runner 字段 + jobs 字典命名空间业主）
 * Composed by: src/assembly/compose-config.ts (yaml `cron.*` field)
 *
 * jobs 字典内每个 job 子字段归该 job owner（详注）。
 * cron 本模块仅 own `enabled` + `tick_interval_ms` + jobs 字典 namespace。
 */
import { z } from 'zod';
import { CRON_TICK_INTERVAL_MS } from './constants.js';

const SCHEDULE_REGEX = /^(?:hourly|daily:\d{1,2}:\d{2}|interval:\d+[smh])$/;

// 通用 schedule 子 schema（cron 本模块 own、job owner 复用）
export const cronJobScheduleField = z.string().regex(SCHEDULE_REGEX);

// 各 job 子 schema 内联（Step A 阶段集中、Step B/C 可决定是否进一步迁到各 job owner）
// 注：cron jobs 子字段实际 own 应归各 job owner（dream_trigger → memory-system 等）
// Step A 先内联在 cron 本 file、Step B composer 立后评估是否进一步拆。
export const cronJobsConfigSchema = z.object({
  dream_trigger: z.object({
    enabled: z.boolean().default(false),
    schedule: cronJobScheduleField.default('daily:04:00'),
    max_compression_tokens: z.number().min(500).max(20000).default(4000),
  }).default({}),
  contract_observer: z.object({
    enabled: z.boolean().default(true),
    schedule: cronJobScheduleField.default('interval:1s'),
  }).default({}),
  audit_size_monitor: z.object({
    enabled: z.boolean().default(true),
    schedule: cronJobScheduleField.default('interval:1h'),
  }).default({}),
  outbox_summary: z.object({
    enabled: z.boolean().default(true),
    schedule: cronJobScheduleField.default('interval:1s'),
  }).default({}),
});

export const cronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tick_interval_ms: z.number().min(100).max(60000).default(CRON_TICK_INTERVAL_MS),
  jobs: cronJobsConfigSchema.default({}),
});

export type CronConfig = z.infer<typeof cronConfigSchema>;
export type CronJobsConfig = z.infer<typeof cronJobsConfigSchema>;
