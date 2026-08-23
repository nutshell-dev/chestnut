import type { JSONSchema7 } from '../llm-provider/index.js';

export type ToolProfile = string;

export interface ToolDescriptor {
  name: string;
  description: string;
  schema: JSONSchema7;
}

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: {
    filesAffected?: string[];
    durationMs?: number;
    [key: string]: unknown;
  };
}

import type { Message, ToolDefinition } from '../llm-provider/index.js';

export interface CallerSnapshot {
  /** Caller's current system prompt (Prompt module output). */
  systemPrompt: string;
  /** Caller's full tool list (LLM-facing definitions, profile-filtered). */
  tools: ToolDefinition[];
  /** Caller's current turn dialog messages. */
  messages: Message[];
}
