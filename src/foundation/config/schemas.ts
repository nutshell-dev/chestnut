/**
 * @module L1.Config (factually L2 cross-cutting per arch §6)
 *
 * Zod schemas for global + claw configs / phase 500 sub-file extraction
 */

import { z } from 'zod';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_RESET_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_LLM_RETRY_ATTEMPTS,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_LLM_IDLE_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  DEFAULT_DISK_WARNING_MB,
  CLAW_INACTIVITY_TIMEOUT_MS,
  CRON_TICK_INTERVAL_MS,
  REACT_DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_CONCURRENT_TASKS,
} from '../../constants.js';

// API format code → preset id (for manual entry)
export const FORMAT_MAP: Record<string, string> = {
  '1': 'custom-anthropic',
  '2': 'custom-openai',
  '3': 'custom-gemini',
};

// Zod Schemas (snake_case for YAML compatibility)
export const LLMProviderSchema = z.object({
  preset: z.string().optional(),
  label: z.string().optional(),
  api_key: z.string(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  max_tokens: z.number().min(1).max(128000).default(REACT_DEFAULT_MAX_TOKENS),
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

export const CircuitBreakerSchema = z.object({
  failure_threshold: z.number().min(1).max(20).default(3),
  reset_timeout_ms: z.number().min(1000).max(3600000).default(DEFAULT_RESET_TIMEOUT_MS),
});

export const ClawGlobalConfigSchema = z.object({
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
    max_steps: z.number().min(1).max(1000).default(DEFAULT_MAX_STEPS),
    subagent_max_steps: z.number().min(1).max(200).optional(),
    max_concurrent_tasks: z.number().min(1).max(20).default(DEFAULT_MAX_CONCURRENT_TASKS),
    llm_idle_timeout_ms: z.number().min(0).max(600000).default(DEFAULT_LLM_IDLE_TIMEOUT_MS),
  }).optional(),
  tool_timeout_ms: z.number().min(1000).max(600000).default(DEFAULT_TOOL_TIMEOUT_MS),
  watchdog: z.object({
    interval_ms: z.number().min(5000).default(WATCHDOG_INTERVAL_MS),
    disk_warning_mb: z.number().min(10).default(DEFAULT_DISK_WARNING_MB),
    claw_inactivity_timeout_ms: z.number().min(60000).default(CLAW_INACTIVITY_TIMEOUT_MS),
  }).optional(),
  cron: z.object({
    enabled: z.boolean().default(true),
    tick_interval_ms: z.number().min(100).max(60000).default(CRON_TICK_INTERVAL_MS),
    jobs: z.object({
      disk_monitor: z.object({
        enabled: z.boolean().default(true),
        schedule: z.string().default('hourly'),
      }).optional(),
      llm_stats: z.object({
        enabled: z.boolean().default(true),
        schedule: z.string().default('daily:06:00'),
      }).optional(),
      dream_trigger: z.object({
        enabled: z.boolean().default(false),
        schedule: z.string().default('daily:04:00'),
        max_compression_tokens: z.number().min(500).max(20000).default(4000),
      }).optional(),
      contract_observer: z.object({
        enabled: z.boolean().default(true),
        schedule: z.string().default('interval:1m'),
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
});

export const ClawConfigSchema = z.object({
  name: z.string(),
  llm: z.object({
    primary: LLMProviderSchema.optional(),
  }).optional(),
  max_steps: z.number().min(1).max(1000).optional(),
  tool_profile: z.enum(['full', 'readonly', 'subagent']).default('full'),
  subagent_max_steps: z.number().min(1).max(200).optional(),
  max_concurrent_tasks: z.number().min(1).max(20).default(3),
});

export type ClawGlobalConfig = z.infer<typeof ClawGlobalConfigSchema>;
export type ClawConfig = z.infer<typeof ClawConfigSchema>;
