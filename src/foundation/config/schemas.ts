/**
 * Zod schemas for global + claw configs / phase 500 sub-file extraction
 */

import { z } from 'zod';
import {
  DEFAULT_LLM_IDLE_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_RESET_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_LLM_RETRY_ATTEMPTS,
} from '../llm-orchestrator/defaults.js';

const SCHEDULE_REGEX = /^(?:hourly|daily:\d{1,2}:\d{2}|interval:\d+[smh])$/;

// API format code → preset id (for manual entry)
export const FORMAT_MAP: Record<string, string> = {
  '1': 'custom-anthropic',
  '2': 'custom-openai',
  '3': 'custom-gemini',
};

/**
 * Cross-module config defaults injected at assembly time.
 * Owner module 负责 const 本身；本 interface 是 Config schema 的 dependency contract。
 * 装配期单点聚合见 `src/assembly/config-defaults.ts`。
 */
export interface ConfigDefaults {
  maxSteps: number;
  toolTimeoutMs: number;
  cronTickIntervalMs: number;
  reactDefaultMaxTokens: number;
  defaultMaxConcurrentTasks: number;
  watchdogIntervalMs: number;
  defaultDiskWarningMb: number;
  clawInactivityTimeoutMs: number;
}

// Zod Schemas (snake_case for YAML compatibility)
export function createLLMProviderSchema(defaults: Pick<ConfigDefaults, 'reactDefaultMaxTokens'>) {
  return z.object({
    preset: z.string().min(1).optional(),
    label: z.string().optional(),
    api_key: z.string().min(1, 'api_key must not be empty'),
    base_url: z.string().optional(),
    model: z.string().optional(),
    max_tokens: z.number().min(1).max(128000).default(defaults.reactDefaultMaxTokens),
    temperature: z.number().min(0).max(2).default(0.7),
    timeout_ms: z.number().min(1000).max(600000).default(DEFAULT_LLM_TIMEOUT_MS),
    thinking: z.boolean().optional(),
    thinking_budget_tokens: z.number().min(1).optional(),
    thinking_mode: z.enum(['adaptive', 'enabled']).optional(),
    thinking_effort: z.enum(['low', 'medium', 'high']).optional(),
    extra_headers: z.record(z.string()).optional(),
    drop_thinking_blocks: z.boolean().optional(),
    reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  });
}

export function createCircuitBreakerSchema() {
  return z.object({
    failure_threshold: z.number().min(1).max(20).default(3),
    reset_timeout_ms: z.number().min(1000).max(3600000).default(DEFAULT_RESET_TIMEOUT_MS),
  });
}

export function createClawGlobalConfigSchema(defaults: ConfigDefaults) {
  const LLMProviderSchema = createLLMProviderSchema(defaults);
  const CircuitBreakerSchema = createCircuitBreakerSchema();
  return z.object({
    version: z.string().default('1'),
    default_max_steps: z.number().min(1).max(1000).optional(),
    llm: z.object({
      primary: LLMProviderSchema,
      fallbacks: z.array(LLMProviderSchema).optional(),
      retry_attempts: z.number().min(0).max(10).default(DEFAULT_LLM_RETRY_ATTEMPTS),
      retry_delay_ms: z.number().min(0).max(60000).default(DEFAULT_RETRY_DELAY_MS),
      circuit_breaker: CircuitBreakerSchema.optional(),
    }),
    motion: z.object({
      heartbeat_interval_ms: z.number().min(0).default(0),
      max_steps: z.number().min(1).max(1000).default(defaults.maxSteps),
      subagent_max_steps: z.number().min(1).max(200).optional(),
      max_concurrent_tasks: z.number().min(1).max(20).default(defaults.defaultMaxConcurrentTasks),
      llm_idle_timeout_ms: z.number().min(0).max(600000).default(DEFAULT_LLM_IDLE_TIMEOUT_MS),
    }).optional(),
    tool_timeout_ms: z.number().min(1000).max(600000).default(defaults.toolTimeoutMs),
    watchdog: z.object({
      interval_ms: z.number().min(5000).default(defaults.watchdogIntervalMs),
      disk_warning_mb: z.number().min(10).default(defaults.defaultDiskWarningMb),
      claw_inactivity_timeout_ms: z.number().min(60000).default(defaults.clawInactivityTimeoutMs),
    }).optional(),
    cron: z.object({
      enabled: z.boolean().default(true),
      tick_interval_ms: z.number().min(100).max(60000).default(defaults.cronTickIntervalMs),
      jobs: z.object({
        disk_monitor: z.object({
          enabled: z.boolean().default(true),
          schedule: z.string().regex(SCHEDULE_REGEX).default('hourly'),
        }).optional(),
        llm_stats: z.object({
          enabled: z.boolean().default(true),
          schedule: z.string().regex(SCHEDULE_REGEX).default('daily:06:00'),
        }).optional(),
        dream_trigger: z.object({
          enabled: z.boolean().default(false),
          schedule: z.string().regex(SCHEDULE_REGEX).default('daily:04:00'),
          max_compression_tokens: z.number().min(500).max(20000).default(4000),
        }).optional(),
        contract_observer: z.object({
          enabled: z.boolean().default(true),
          schedule: z.string().regex(SCHEDULE_REGEX).default('interval:1m'),
        }).optional(),
        metrics_snapshot: z.object({
          enabled: z.boolean().default(true),
          schedule: z.string().regex(SCHEDULE_REGEX).default('interval:5m'),
        }).optional(),
        git_gc_weekly: z.object({
          enabled: z.boolean().default(true),
          schedule: z.string().regex(SCHEDULE_REGEX).default('daily:03:00'),
        }).optional(),
        retention_cleanup: z.object({
          enabled: z.boolean().default(true),
          schedule: z.string().regex(SCHEDULE_REGEX).default('daily:04:00'),
        }).optional(),
        audit_size_monitor: z.object({
          enabled: z.boolean().default(true),
          schedule: z.string().regex(SCHEDULE_REGEX).default('interval:6h'),
        }).optional(),
        outbox_drain: z.object({
          enabled: z.boolean().default(true),
          schedule: z.string().regex(SCHEDULE_REGEX).default('interval:30s'),
        }).optional(),
      }).optional(),
    }).optional(),
    viewport: z.object({
      show_recap_stream: z.boolean().default(false),
      show_system_messages: z.boolean().default(false),
      show_contract_events: z.boolean().default(true),
      trim_output_newlines: z.boolean().default(true),
    }).optional(),
    audit: z.object({
      retention: z.object({
        max_size_mb: z.number().min(1).nullable().default(null),
      }).optional(),
    }).optional(),
    stream: z.object({
      retention: z.object({
        max_files: z.number().min(1).nullable().default(null),
        max_days: z.number().min(1).nullable().default(null),
      }).optional(),
    }).optional(),
    retention: z.object({
      inbox_max_days: z.number().int().positive().default(30),
      outbox_max_days: z.number().int().positive().default(30),
      tasks_max_days: z.number().int().positive().default(60),
      dialog_max_days: z.number().int().positive().default(90),
    }).optional(),
  });
}

export function createClawConfigSchema(defaults: ConfigDefaults) {
  const LLMProviderSchema = createLLMProviderSchema(defaults);
  return z.object({
    name: z.string(),
    llm: z.object({
      primary: LLMProviderSchema.optional(),
    }).optional(),
    max_steps: z.number().min(1).max(1000).optional(),
    tool_profile: z.enum(['full', 'readonly', 'subagent']).default('full'),
    subagent_max_steps: z.number().min(1).max(200).optional(),
    max_concurrent_tasks: z.number().min(1).max(20).default(3),
  });
}

// Type exports
export type LLMProviderConfig = z.infer<ReturnType<typeof createLLMProviderSchema>>;
export type ClawGlobalConfig = z.infer<ReturnType<typeof createClawGlobalConfigSchema>>;
export type ClawConfig = z.infer<ReturnType<typeof createClawConfigSchema>>;
