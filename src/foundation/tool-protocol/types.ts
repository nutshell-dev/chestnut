import type { llmProviderProtocol } from '../llm-provider/index.js';
type JSONSchema7 = llmProviderProtocol.JSONSchema7;
type ToolDefinition = llmProviderProtocol.ToolDefinition;

export type ToolProfile = string;

export interface ToolDescriptor {
  name: string;
  description: string;
  schema: JSONSchema7;
}

/**
 * Artifact state for a tool result whose complete content has an owner.
 * `failed` means no retrievable artifact was committed; the other states carry
 * a workspace-display path and mirror FileSystem.writeAtomic's durability
 * protocol without making ToolProtocol depend on the fs module.
 */
export type ToolResultArtifact =
  | { kind: 'durable'; path: string }
  | { kind: 'committed_platform_limited'; path: string }
  | { kind: 'committed_durability_unknown'; path: string }
  | { kind: 'failed' };

/**
 * Presence of this field declares that `content` is already an owner-produced
 * final preview, not raw output that may be persisted as though it were
 * complete. Generic executors must never save such a preview a second time.
 */
export interface ToolResultOutput {
  readonly ownerBounded: true;
  readonly artifact?: ToolResultArtifact;
}

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: {
    filesAffected?: string[];
    durationMs?: number;
    output?: ToolResultOutput;
    [key: string]: unknown;
  };
}


import type { Message } from '../dialog-store/index.js';

export interface CallerSnapshot {
  /** Frozen parent-turn system prompt. */
  systemPrompt: string;
  /** Canonical provider-facing definitions; never profile-filtered. */
  tools: ToolDefinition[];
  /** Frozen parent-turn dialog prefix. */
  messages: Message[];
  /** Content identity of the canonical tool manifest. */
  manifestRevision: string;
  /** SHA-256 content identity of the static system prompt. */
  promptRevision: string;
}
