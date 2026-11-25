/**
 * Versioned, JSON-only execution declaration owned by SubAgent.
 * Runtime handles and implementations are deliberately absent from this format.
 */

import type { Message } from '../../foundation/dialog-store/index.js';
import type { llmProviderProtocol } from '../../foundation/llm-provider/index.js';
import {
  createCanonicalToolManifestFromDefinitions,
  type CanonicalToolManifest,
  type ToolExecutionContext,
} from '../../foundation/tools/index.js';
import type { ToolProfile } from '../../foundation/tool-protocol/index.js';
import {
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  renderSubagentWorkspacePromptTemplate,
  SUBAGENT_WORKSPACE_PROMPT_TEMPLATE,
  type SubagentWorkspacePromptTemplateParameters,
} from '../../templates/prompts/subagent.js';
import { SUBAGENT_TIMEOUT_MS } from './constants.js';
import { DONE_TOOL_NAME } from './tools/done.js';
import { DEFAULT_SUBAGENT_TOOL_PROFILE } from './agent.js';

type ToolDefinition = llmProviderProtocol.ToolDefinition;

export const PREPARED_SUBAGENT_INPUT_KIND = 'prepared_subagent_input' as const;

export interface SubagentTextSystemPrompt {
  readonly kind: 'text';
  readonly text: string;
}

export interface SubagentTemplateSystemPrompt {
  readonly kind: 'template';
  readonly template: typeof SUBAGENT_WORKSPACE_PROMPT_TEMPLATE.name;
  readonly version: typeof SUBAGENT_WORKSPACE_PROMPT_TEMPLATE.version;
  readonly parameters: SubagentWorkspacePromptTemplateParameters;
}

export type SubagentSystemPromptDeclaration = SubagentTextSystemPrompt | SubagentTemplateSystemPrompt;

export interface SubagentInputBudgetDeclaration {
  readonly timeoutMs?: number;
  readonly maxSteps?: number;
  readonly idleTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
}

export interface PreparedSubagentInputBudget {
  readonly timeoutMs: number;
  readonly maxSteps?: number;
  readonly idleTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
}

export interface SubagentResultCaptureDeclaration {
  readonly toolName: string;
}

export interface SubagentInputDeclaration {
  readonly prompt: string;
  readonly systemPrompt?: string | SubagentSystemPromptDeclaration;
  readonly messages?: readonly Message[];
  readonly tools: { readonly manifest: CanonicalToolManifest };
  readonly execution?: ToolExecutionContext;
  readonly toolProfile?: ToolProfile;
  readonly budget?: SubagentInputBudgetDeclaration;
  readonly resultCapture?: SubagentResultCaptureDeclaration;
}

export interface PreparedSubagentInput {
  readonly schema_version: 1;
  readonly kind: typeof PREPARED_SUBAGENT_INPUT_KIND;
  readonly prompt: string;
  readonly systemPrompt: SubagentSystemPromptDeclaration;
  readonly messages?: readonly Message[];
  readonly tools: { readonly manifest: CanonicalToolManifest };
  readonly execution: ToolExecutionContext;
  readonly toolProfile: ToolProfile;
  readonly budget: PreparedSubagentInputBudget;
  readonly resultCapture: SubagentResultCaptureDeclaration;
}

const DEFAULT_EXECUTION: ToolExecutionContext = {
  callerKind: 'task',
  allowDone: true,
  allowShadow: false,
  allowSummon: false,
  allowNotifyClaw: false,
};

function invalid(path: string, expectation: string): never {
  throw new TypeError(`invalid PreparedSubagentInput at ${path}: ${expectation}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid(path, 'expected an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, 'expected a plain object');
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) invalid(path, `unknown field(s): ${unknown.join(', ')}`);
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') invalid(path, 'expected a string');
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (value.length === 0) invalid(path, 'expected a non-empty string');
}

function assertOptionalString(value: unknown, path: string): void {
  if (value !== undefined) assertString(value, path);
}

function assertNonNegativeNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalid(path, 'expected a finite non-negative number');
  }
}

function assertJson(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'expected a finite JSON number');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) invalid(path, 'expected a JSON value');
  assertRecord(value, path);
  for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['name', 'description', 'input_schema'].every(key => Object.hasOwn(value, key))) {
    return false;
  }
  return typeof value.name === 'string' && value.name.length > 0
    && typeof value.description === 'string' && isRecord(value.input_schema);
}

function assertManifest(value: unknown, path: string): asserts value is CanonicalToolManifest {
  assertRecord(value, path);
  assertExactKeys(value, ['revision', 'definitions', 'llmTools'], path);
  assertNonEmptyString(value.revision, `${path}.revision`);
  if (!/^[a-f0-9]{64}$/.test(value.revision)) invalid(`${path}.revision`, 'expected a canonical SHA-256 reference');
  if (!Array.isArray(value.definitions)) invalid(`${path}.definitions`, 'expected an array');
  if (!Array.isArray(value.llmTools) || !value.llmTools.every(isToolDefinition)) {
    invalid(`${path}.llmTools`, 'expected canonical tool definitions');
  }
  const expected = createCanonicalToolManifestFromDefinitions(value.llmTools);
  // The execution store canonicalizes JSON object key order. The revision remains
  // Tools' opaque reference; only the canonical descriptor/tool relationship is
  // revalidated here, without redefining Tools' hash serialization.
  if (!jsonEqual(value.definitions, expected.definitions)
    || !jsonEqual(value.llmTools, expected.llmTools)) {
    invalid(path, 'manifest definitions do not match canonical provider tools');
  }
}

function assertContentBlock(value: unknown, path: string): void {
  assertRecord(value, path);
  assertNonEmptyString(value.type, `${path}.type`);
  const blockId = value.blockId;
  if (blockId !== undefined) assertString(blockId, `${path}.blockId`);
  if (value.type === 'text') {
    assertExactKeys(value, ['type', 'text', 'blockId'], path);
    assertString(value.text, `${path}.text`);
  } else if (value.type === 'tool_use') {
    assertExactKeys(value, ['type', 'id', 'name', 'input', 'blockId'], path);
    assertNonEmptyString(value.id, `${path}.id`);
    assertNonEmptyString(value.name, `${path}.name`);
    assertRecord(value.input, `${path}.input`);
  } else if (value.type === 'tool_result') {
    assertExactKeys(value, ['type', 'tool_use_id', 'content', 'is_error', 'blockId'], path);
    assertNonEmptyString(value.tool_use_id, `${path}.tool_use_id`);
    assertString(value.content, `${path}.content`);
    if (value.is_error !== undefined && typeof value.is_error !== 'boolean') {
      invalid(`${path}.is_error`, 'expected a boolean');
    }
  } else if (value.type === 'thinking') {
    assertExactKeys(value, ['type', 'thinking', 'signature', 'blockId'], path);
    assertString(value.thinking, `${path}.thinking`);
    assertOptionalString(value.signature, `${path}.signature`);
  }
}

function assertMessages(value: unknown, path: string): asserts value is readonly Message[] {
  if (!Array.isArray(value)) invalid(path, 'expected an array');
  value.forEach((message, index) => {
    const itemPath = `${path}[${index}]`;
    assertRecord(message, itemPath);
    assertExactKeys(
      message,
      ['role', 'content', 'origin', 'systemSubtype', 'addedAt', 'inboxId', 'trimmed'],
      itemPath,
    );
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
      invalid(`${itemPath}.role`, 'expected user, assistant or system');
    }
    if (typeof message.content !== 'string') {
      if (!Array.isArray(message.content)) invalid(`${itemPath}.content`, 'expected a string or content blocks');
      message.content.forEach((block, blockIndex) => assertContentBlock(block, `${itemPath}.content[${blockIndex}]`));
    }
    if (message.origin !== undefined && message.origin !== 'user' && message.origin !== 'system') {
      invalid(`${itemPath}.origin`, 'expected user or system');
    }
    assertOptionalString(message.systemSubtype, `${itemPath}.systemSubtype`);
    assertOptionalString(message.addedAt, `${itemPath}.addedAt`);
    assertOptionalString(message.inboxId, `${itemPath}.inboxId`);
    if (message.trimmed !== undefined) {
      assertRecord(message.trimmed, `${itemPath}.trimmed`);
      assertExactKeys(message.trimmed, ['trimmedAt', 'originalContentBytes', 'timesTrimmed'], `${itemPath}.trimmed`);
      assertString(message.trimmed.trimmedAt, `${itemPath}.trimmed.trimmedAt`);
      assertNonNegativeNumber(message.trimmed.originalContentBytes, `${itemPath}.trimmed.originalContentBytes`);
      if (message.trimmed.timesTrimmed !== undefined) {
        assertNonNegativeNumber(message.trimmed.timesTrimmed, `${itemPath}.trimmed.timesTrimmed`);
      }
    }
  });
}

function assertSystemPrompt(value: unknown, path: string): asserts value is SubagentSystemPromptDeclaration {
  assertRecord(value, path);
  if (value.kind === 'text') {
    assertExactKeys(value, ['kind', 'text'], path);
    assertString(value.text, `${path}.text`);
    return;
  }
  if (value.kind !== 'template') invalid(`${path}.kind`, 'expected text or template');
  assertExactKeys(value, ['kind', 'template', 'version', 'parameters'], path);
  if (value.template !== SUBAGENT_WORKSPACE_PROMPT_TEMPLATE.name) {
    invalid(`${path}.template`, 'unsupported template');
  }
  if (value.version !== SUBAGENT_WORKSPACE_PROMPT_TEMPLATE.version) {
    invalid(`${path}.version`, `unsupported template version: ${String(value.version)}`);
  }
  assertRecord(value.parameters, `${path}.parameters`);
  assertExactKeys(value.parameters, ['callerClawId', 'subagentsDir', 'systemPrompt'], `${path}.parameters`);
  assertNonEmptyString(value.parameters.callerClawId, `${path}.parameters.callerClawId`);
  assertNonEmptyString(value.parameters.subagentsDir, `${path}.parameters.subagentsDir`);
  assertOptionalString(value.parameters.systemPrompt, `${path}.parameters.systemPrompt`);
}

function assertExecution(value: unknown, path: string): asserts value is ToolExecutionContext {
  assertRecord(value, path);
  assertExactKeys(
    value,
    ['callerKind', 'allowDone', 'allowShadow', 'allowSummon', 'allowNotifyClaw', 'manifestRevision'],
    path,
  );
  assertNonEmptyString(value.callerKind, `${path}.callerKind`);
  for (const field of ['allowDone', 'allowShadow', 'allowSummon', 'allowNotifyClaw'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      invalid(`${path}.${field}`, 'expected a boolean');
    }
  }
  if (value.manifestRevision !== undefined) {
    assertNonEmptyString(value.manifestRevision, `${path}.manifestRevision`);
  }
}

function assertBudget(value: unknown, path: string): asserts value is PreparedSubagentInputBudget {
  assertRecord(value, path);
  assertExactKeys(value, ['timeoutMs', 'maxSteps', 'idleTimeoutMs', 'toolTimeoutMs'], path);
  assertNonNegativeNumber(value.timeoutMs, `${path}.timeoutMs`);
  for (const field of ['idleTimeoutMs', 'toolTimeoutMs'] as const) {
    if (value[field] !== undefined) assertNonNegativeNumber(value[field], `${path}.${field}`);
  }
  if (value.maxSteps !== undefined) {
    assertNonNegativeNumber(value.maxSteps, `${path}.maxSteps`);
    if (!Number.isInteger(value.maxSteps)) invalid(`${path}.maxSteps`, 'expected an integer');
  }
}

function assertPrepared(value: unknown): asserts value is PreparedSubagentInput {
  assertJson(value, 'PreparedSubagentInput');
  assertRecord(value, 'PreparedSubagentInput');
  if (value.schema_version !== 1) {
    throw new TypeError(`unsupported PreparedSubagentInput schema_version: ${String(value.schema_version)}`);
  }
  if (value.kind !== PREPARED_SUBAGENT_INPUT_KIND) invalid('kind', `expected ${PREPARED_SUBAGENT_INPUT_KIND}`);
  assertExactKeys(
    value,
    [
      'schema_version', 'kind', 'prompt', 'systemPrompt', 'messages', 'tools',
      'execution', 'toolProfile', 'budget', 'resultCapture',
    ],
    'PreparedSubagentInput',
  );
  assertString(value.prompt, 'prompt');
  assertSystemPrompt(value.systemPrompt, 'systemPrompt');
  if (value.messages !== undefined) assertMessages(value.messages, 'messages');
  assertRecord(value.tools, 'tools');
  assertExactKeys(value.tools, ['manifest'], 'tools');
  assertManifest(value.tools.manifest, 'tools.manifest');
  assertExecution(value.execution, 'execution');
  if (value.execution.manifestRevision !== undefined
    && value.execution.manifestRevision !== value.tools.manifest.revision) {
    invalid('execution.manifestRevision', 'must reference tools.manifest.revision');
  }
  assertNonEmptyString(value.toolProfile, 'toolProfile');
  assertBudget(value.budget, 'budget');
  assertRecord(value.resultCapture, 'resultCapture');
  assertExactKeys(value.resultCapture, ['toolName'], 'resultCapture');
  assertNonEmptyString(value.resultCapture.toolName, 'resultCapture.toolName');
}

/** Strict decode: unsupported versions and unknown fields are rejected, never stripped. */
export function decodeSubagentInput(value: unknown): PreparedSubagentInput {
  assertPrepared(value);
  return structuredClone(value);
}

/** Apply only SubAgent-owned ordinary defaults; business choices remain with the caller. */
export function prepareSubagentInput(declaration: SubagentInputDeclaration): PreparedSubagentInput {
  assertJson(declaration, 'SubagentInputDeclaration');
  assertRecord(declaration, 'SubagentInputDeclaration');
  assertExactKeys(
    declaration,
    ['prompt', 'systemPrompt', 'messages', 'tools', 'execution', 'toolProfile', 'budget', 'resultCapture'],
    'SubagentInputDeclaration',
  );
  const systemPrompt = declaration.systemPrompt === undefined
    ? { kind: 'text', text: DEFAULT_SUBAGENT_SYSTEM_PROMPT }
    : typeof declaration.systemPrompt === 'string'
      ? { kind: 'text', text: declaration.systemPrompt }
      : declaration.systemPrompt;
  return decodeSubagentInput({
    schema_version: 1,
    kind: PREPARED_SUBAGENT_INPUT_KIND,
    prompt: declaration.prompt,
    systemPrompt,
    ...(declaration.messages !== undefined ? { messages: declaration.messages } : {}),
    tools: declaration.tools,
    execution: declaration.execution ?? DEFAULT_EXECUTION,
    toolProfile: declaration.toolProfile ?? DEFAULT_SUBAGENT_TOOL_PROFILE,
    budget: { timeoutMs: SUBAGENT_TIMEOUT_MS, ...declaration.budget },
    resultCapture: declaration.resultCapture ?? { toolName: DONE_TOOL_NAME },
  });
}

/** Expand identity-bound variables only after the real execution identity exists. */
export function resolveSubagentSystemPrompt(
  declaration: SubagentSystemPromptDeclaration,
  identity: { readonly taskId: string },
): string {
  assertNonEmptyString(identity.taskId, 'identity.taskId');
  if (declaration.kind === 'text') return declaration.text;
  return renderSubagentWorkspacePromptTemplate(declaration.parameters, identity);
}
