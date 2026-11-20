/** @module L1.LLMProvider.CommonInputProjection */
import type { CompleteInput, CompleteInputMessage, CompleteInputTool } from './input-meter-types.js';

/** Versioned projection key; this is not a provider wire-template revision. */
export const COMMON_INPUT_PROJECTION_REVISION = 'common-input-text-v1' as const;
export const COMMON_INPUT_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxMessages: 4_096,
  supportedTools: 'declared' as const,
});

const MAX_TOOLS = 256;
const MAX_CONTENT_PARTS = 256;
const MAX_STRUCTURED_DEPTH = 32;
const MAX_STRUCTURED_NODES = 10_000;
const MAX_STRUCTURED_BYTES = 4 * 1024 * 1024;

export class CommonInputProjectionUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CommonInputProjectionUnsupported';
  }
}

function unsupported(reason: string): never {
  throw new CommonInputProjectionUnsupported(reason);
}

interface ProjectionBudget {
  bytes: number;
  structuredNodes: number;
}

function appendText(segments: string[], text: string, budget: ProjectionBudget): void {
  budget.bytes += Buffer.byteLength(text, 'utf8');
  if (budget.bytes > COMMON_INPUT_LIMITS.maxInputBytes) unsupported('input_bytes_limit_exceeded');
  segments.push(text);
}

function assertStructuredBudget(budget: ProjectionBudget): void {
  budget.structuredNodes += 1;
  if (budget.structuredNodes > MAX_STRUCTURED_NODES) unsupported('structured_content_limit_exceeded');
}

function assertStructuredBytes(bytes: number): void {
  if (bytes > MAX_STRUCTURED_BYTES) unsupported('structured_content_limit_exceeded');
}

/** Stable JSON for declared tool schemas/inputs only; arbitrary SDK requests are never accepted. */
function stableStructuredText(
  value: unknown,
  budget: ProjectionBudget,
  depth = 0,
  ancestors = new Set<object>(),
): string {
  assertStructuredBudget(budget);
  if (value === null) return 'null';
  if (typeof value === 'string') {
    assertStructuredBytes(Buffer.byteLength(value, 'utf8'));
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) unsupported('invalid_structured_content');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') unsupported('invalid_structured_content');
  if (depth >= MAX_STRUCTURED_DEPTH || ancestors.has(value)) unsupported('structured_content_limit_exceeded');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    unsupported('invalid_structured_content');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map(item => stableStructuredText(item, budget, depth + 1, ancestors));
      const result = `[${items.join(',')}]`;
      assertStructuredBytes(Buffer.byteLength(result, 'utf8'));
      return result;
    }
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record).sort().map(key => {
      const item = stableStructuredText(record[key], budget, depth + 1, ancestors);
      return `${JSON.stringify(key)}:${item}`;
    });
    const result = `{${properties.join(',')}}`;
    assertStructuredBytes(Buffer.byteLength(result, 'utf8'));
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function appendContent(
  content: unknown,
  segments: string[],
  budget: ProjectionBudget,
  ancestors: Set<object>,
  depth = 0,
): void {
  if (typeof content === 'string') {
    appendText(segments, content, budget);
    return;
  }
  if (!Array.isArray(content) || depth >= MAX_STRUCTURED_DEPTH || ancestors.has(content)) {
    unsupported('non_text_content');
  }
  if (content.length > MAX_CONTENT_PARTS) unsupported('content_parts_limit_exceeded');
  ancestors.add(content);
  try {
    for (const part of content) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) unsupported('non_text_content');
      const block = part as Record<string, unknown>;
      switch (block.type) {
        case 'text':
          if (typeof block.text !== 'string') unsupported('non_text_content');
          appendText(segments, block.text, budget);
          break;
        case 'thinking':
          if (typeof block.thinking !== 'string') unsupported('non_text_content');
          appendText(segments, block.thinking, budget);
          break;
        case 'tool_use':
          if (typeof block.name !== 'string') unsupported('non_text_content');
          appendText(segments, block.name, budget);
          appendText(segments, stableStructuredText(block.input ?? {}, budget), budget);
          break;
        case 'tool_result':
          if (typeof block.content !== 'string' && !Array.isArray(block.content)) {
            unsupported('non_text_content');
          }
          appendContent(block.content, segments, budget, ancestors, depth + 1);
          break;
        default:
          unsupported('non_text_content');
      }
    }
  } finally {
    ancestors.delete(content);
  }
}

function appendTool(
  tool: CompleteInputTool,
  segments: string[],
  budget: ProjectionBudget,
): void {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)
    || typeof tool.name !== 'string' || typeof tool.description !== 'string') {
    unsupported('invalid_tool_definition');
  }
  appendText(segments, tool.name, budget);
  appendText(segments, tool.description, budget);
  appendText(segments, stableStructuredText(tool.input_schema, budget), budget);
}

/** Extract only explicit text, tool declarations, tool calls/results and thinking text. */
export function commonInputTextSegments(input: CompleteInput): readonly string[] {
  if (!Array.isArray(input.messages)) unsupported('messages_not_array');
  if (input.messages.length > COMMON_INPUT_LIMITS.maxMessages) unsupported('messages_limit_exceeded');
  if (input.system !== undefined && typeof input.system !== 'string') unsupported('non_text_system');
  if (input.system !== undefined && input.messages.some(message => message.role === 'system')) {
    unsupported('duplicate_system');
  }
  if (input.tools !== undefined && !Array.isArray(input.tools)) unsupported('tools_not_array');
  if ((input.tools?.length ?? 0) > MAX_TOOLS) unsupported('tools_limit_exceeded');

  const segments: string[] = [];
  const budget: ProjectionBudget = { bytes: 0, structuredNodes: 0 };
  if (input.system !== undefined) appendText(segments, input.system, budget);
  for (const message of input.messages) {
    const role = (message as CompleteInputMessage | null)?.role as string;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') unsupported(`role:${role}`);
    appendContent(message.content, segments, budget, new Set());
  }
  for (const tool of input.tools ?? []) appendTool(tool, segments, budget);
  return segments;
}
