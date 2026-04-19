/**
 * CLI Configuration - 配置加载和类型定义
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { LLMServiceConfig, ProviderConfig } from '../foundation/llm/types.js';
import { resolvePreset } from '../foundation/llm/presets.js';

// Re-export shared constants
export { CLAW_SUBDIRS } from '../types/paths.js';

// API format code → preset id (for manual entry)
export const FORMAT_MAP: Record<string, string> = {
  '1': 'custom-anthropic',
  '2': 'custom-openai',
  '3': 'custom-gemini',
};

// Zod Schemas (snake_case for YAML compatibility)
export const LLMProviderSchema = z.object({
  preset: z.string().optional(),         // 新：对应 PRESETS 中的 key
  label: z.string().optional(),          // 新：显示用别名
  api_key: z.string(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  max_tokens: z.number().min(1).max(128000).default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  timeout_ms: z.number().min(1000).max(600000).default(60000),
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
  reset_timeout_ms: z.number().min(1000).max(3600000).default(60000),
});

export const ClawGlobalConfigSchema = z.object({
  version: z.string().default('1'),
  llm: z.object({
    primary: LLMProviderSchema,
    fallbacks: z.array(LLMProviderSchema).optional(), // 新增：多级 fallback 链
    retry_attempts: z.number().min(0).max(10).default(3),
    retry_delay_ms: z.number().min(0).max(60000).default(1000),
    circuit_breaker: CircuitBreakerSchema.optional(), // 新增：熔断器配置
  }),
  motion: z.object({
    heartbeat_interval_ms: z.number().min(0).default(0),
    max_steps: z.number().min(1).max(1000).default(100),
    subagent_max_steps: z.number().min(1).max(200).optional(),
    max_concurrent_tasks: z.number().min(1).max(20).default(3),
    llm_idle_timeout_ms: z.number().min(0).max(600000).default(60000),
  }).optional(),
  tool_timeout_ms: z.number().min(1000).max(600000).default(60000),
  watchdog: z.object({
    interval_ms: z.number().min(5000).default(30000),
    disk_warning_mb: z.number().min(10).default(500),
    claw_inactivity_timeout_ms: z.number().min(60000).default(300000),
  }).optional(),
  cron: z.object({
    enabled: z.boolean().default(true),
    tick_interval_ms: z.number().min(100).max(60000).default(1000),
    jobs: z.object({
      disk_monitor: z.object({
        enabled: z.boolean().default(true),
        schedule: z.string().default('hourly'),  // "hourly" | "daily:HH:MM" | "interval:Nm"
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
  max_steps: z.number().min(1).max(1000).default(100),
  tool_profile: z.enum(['full', 'readonly', 'subagent', 'dream']).default('full'),
  subagent_max_steps: z.number().min(1).max(200).optional(),
  max_concurrent_tasks: z.number().min(1).max(20).default(3),
});

export type ClawGlobalConfig = z.infer<typeof ClawGlobalConfigSchema>;
export type ClawConfig = z.infer<typeof ClawConfigSchema>;

// Tool profile for tool permission management
export type ToolProfile = 'full' | 'readonly' | 'subagent' | 'dream';

// Workspace root - 优先从环境变量获取（供 exec 子进程继承）
export function getWorkspaceRoot(): string {
  return process.env.CLAWFORUM_ROOT ?? process.cwd();
}

// Paths
export function getGlobalConfigPath(): string {
  return path.join(getWorkspaceRoot(), '.clawforum', 'config.yaml');
}

export function getClawDir(name: string): string {
  return path.join(getWorkspaceRoot(), '.clawforum', 'claws', name);
}

export function getMotionDir(): string {
  return path.join(getWorkspaceRoot(), '.clawforum', 'motion');
}

export function getClawforumRoot(): string {
  return path.join(getWorkspaceRoot(), '.clawforum');
}

export function resolveAgentDir(id: string): string {
  return id === 'motion' ? getMotionDir() : getClawDir(id);
}

export function getClawConfigPath(name: string): string {
  return path.join(getClawDir(name), 'config.yaml');
}

// Expand ${ENV_VAR} syntax in config values
function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const val = process.env[varName];
      if (val === undefined) {
        throw new Error(`Environment variable "${varName}" is not set`);
      }
      return val;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVars(value);
    }
    return result;
  }
  return obj;
}

// Load global config
export function loadGlobalConfig(): ClawGlobalConfig {
  const configPath = getGlobalConfigPath();
  
  if (!fs.existsSync(configPath)) {
    throw new Error(
      'Global config not found. Run "clawforum init" first.'
    );
  }
  
  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(content);
  
  // Expand environment variables before validation
  const expanded = expandEnvVars(parsed);
  
  try {
    return ClawGlobalConfigSchema.parse(expanded);
  } catch (error) {
    throw new Error(
      `Invalid global config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Check if initialized
export function isInitialized(): boolean {
  return fs.existsSync(getGlobalConfigPath());
}

// Save global config
export function saveGlobalConfig(config: ClawGlobalConfig): void {
  const configPath = getGlobalConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml.dump(config));
}

// Load claw config
export function loadClawConfig(name: string): ClawConfig {
  const configPath = getClawConfigPath(name);
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Claw "${name}" not found.`);
  }
  
  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(content);
  
  try {
    return ClawConfigSchema.parse(parsed);
  } catch (error) {
    throw new Error(
      `Invalid claw config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Patch the primary LLM config in-place (raw YAML read/write, no Zod round-trip)
export function patchGlobalConfigPrimary(patch: Record<string, unknown>): void {
  const configPath = getGlobalConfigPath();
  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  const llm = (raw.llm ?? {}) as Record<string, unknown>;
  const primary = (llm.primary ?? {}) as Record<string, unknown>;
  llm.primary = { ...primary, ...patch };
  raw.llm = llm;
  fs.writeFileSync(configPath, yaml.dump(raw));
}

// Save claw config
export function saveClawConfig(name: string, config: ClawConfig): void {
  const clawDir = getClawDir(name);
  fs.mkdirSync(clawDir, { recursive: true });
  
  const configPath = getClawConfigPath(name);
  fs.writeFileSync(configPath, yaml.dump(config));
}

// Check if claw exists
export function clawExists(name: string): boolean {
  return fs.existsSync(getClawConfigPath(name));
}

// Convert snake_case to camelCase, resolve preset
export function toProviderConfig(p: z.infer<typeof LLMProviderSchema>): ProviderConfig {
  const presetId = p.preset;
  if (!presetId) {
    throw new Error('Provider config must have "preset" field');
  }
  
  const preset = resolvePreset(presetId);

  // Detect bare env var names that should be wrapped in ${...}
  if (p.api_key && /^[A-Z][A-Z0-9_]{3,}$/.test(p.api_key)) {
    throw new Error(
      `Provider "${p.label ?? presetId}": api_key looks like a bare environment variable name ("${p.api_key}"). ` +
      `Use \${${p.api_key}} to reference it.`
    );
  }

  return {
    name: p.label ?? presetId,
    apiKey: p.api_key,
    baseUrl: p.base_url ?? preset.defaultBaseUrl,
    // 'auto' (or omitted) → use preset's current defaultModel
    model: (!p.model || p.model === 'auto') ? (preset.defaultModel ?? 'unknown') : p.model,
    maxTokens: p.max_tokens,
    temperature: p.temperature,
    timeoutMs: p.timeout_ms,
    thinking: p.thinking,
    thinkingBudgetTokens: p.thinking_budget_tokens,
    thinkingMode: p.thinking_mode,
    thinkingEffort: p.thinking_effort,
    extraHeaders: p.extra_headers,
    dropThinkingBlocks: p.drop_thinking_blocks,
    apiFormat: preset.apiFormat,
    reasoningEffort: p.reasoning_effort,
  };
}

// Build LLMServiceConfig from global + claw config
export function buildLLMConfig(
  globalConfig: ClawGlobalConfig,
  clawConfig?: ClawConfig
): LLMServiceConfig {
  // Use claw's primary if provided, otherwise use global's primary
  const primaryProvider = clawConfig?.llm?.primary 
    ? toProviderConfig(clawConfig.llm.primary)
    : toProviderConfig(globalConfig.llm.primary);
  
  const fallbackList = globalConfig.llm.fallbacks ?? [];
  
  // Circuit breaker config
  const cb = globalConfig.llm.circuit_breaker;
  
  return {
    primary: primaryProvider,
    fallbacks: fallbackList.map(toProviderConfig),
    maxAttempts: globalConfig.llm.retry_attempts,
    retryDelayMs: globalConfig.llm.retry_delay_ms,
    circuitBreaker: cb ? {
      failureThreshold: cb.failure_threshold,
      resetTimeoutMs: cb.reset_timeout_ms,
    } : undefined,
  };
}
