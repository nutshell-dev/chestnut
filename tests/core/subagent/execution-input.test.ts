import { describe, expect, it } from 'vitest';
import { createCanonicalToolManifestFromDefinitions } from '../../../src/foundation/tools/index.js';
import {
  decodeSubagentInput,
  prepareSubagentInput,
  resolveSubagentSystemPrompt,
  type PreparedSubagentInput,
  type SubagentInputDeclaration,
} from '../../../src/core/subagent/execution-input.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT, SUBAGENT_WORKSPACE_PROMPT_TEMPLATE } from '../../../src/templates/prompts/subagent.js';
import { SUBAGENT_TIMEOUT_MS } from '../../../src/core/subagent/constants.js';

const manifest = createCanonicalToolManifestFromDefinitions([
  {
    name: 'read',
    description: 'read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]);

function declaration(): SubagentInputDeclaration {
  return {
    prompt: 'perform the delegated task',
    systemPrompt: {
      kind: 'template',
      template: SUBAGENT_WORKSPACE_PROMPT_TEMPLATE.name,
      version: SUBAGENT_WORKSPACE_PROMPT_TEMPLATE.version,
      parameters: {
        callerClawId: 'caller',
        subagentsDir: 'tasks/subagents',
        systemPrompt: 'owner supplied instructions',
      },
    },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'retained context', blockId: 'block-1' }] },
      { role: 'assistant', content: 'prior answer', origin: 'system', addedAt: '2026-01-01T00:00:00.000Z' },
    ],
    tools: { manifest },
    execution: {
      callerKind: 'owner',
      allowDone: true,
      allowShadow: false,
      allowSummon: false,
      allowNotifyClaw: false,
      manifestRevision: manifest.revision,
    },
    toolProfile: 'full',
    budget: { timeoutMs: 5_000, maxSteps: 4, idleTimeoutMs: 100, toolTimeoutMs: 200 }, // time-fixture: bounded execution-input round-trip payload
    resultCapture: { toolName: 'done' },
  };
}

function roundTrip(value: PreparedSubagentInput): PreparedSubagentInput {
  return decodeSubagentInput(JSON.parse(JSON.stringify(value)));
}

describe('Phase 2248 Step E PreparedSubagentInput', () => {
  it('prepares ordinary defaults and preserves them through an equivalent JSON round trip', () => {
    const prepared = prepareSubagentInput({ prompt: 'ordinary task', tools: { manifest } });
    expect(prepared).toMatchObject({
      schema_version: 1,
      kind: 'prepared_subagent_input',
      prompt: 'ordinary task',
      systemPrompt: { kind: 'text', text: DEFAULT_SUBAGENT_SYSTEM_PROMPT },
      execution: {
        callerKind: 'task', allowDone: true, allowShadow: false,
        allowSummon: false, allowNotifyClaw: false,
      },
      toolProfile: 'subagent',
      budget: { timeoutMs: SUBAGENT_TIMEOUT_MS },
      resultCapture: { toolName: 'done' },
    });
    expect(prepared).not.toHaveProperty('messages');
    const restored = roundTrip(prepared);
    expect(restored).toEqual(prepared);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(prepared));
  });

  it('persists messages, capabilities, canonical tools, budget and capture without early task identity', () => {
    const prepared = prepareSubagentInput(declaration());
    expect(roundTrip(prepared)).toEqual(prepared);
    expect(prepared.tools.manifest.llmTools).toEqual(manifest.llmTools);
    const template = prepared.systemPrompt;
    if (template.kind !== 'template') throw new TypeError('template fixture required');
    expect(template.parameters).not.toHaveProperty('taskId');
    expect(JSON.stringify(prepared)).not.toContain('actual-task-id');

    const rendered = resolveSubagentSystemPrompt(template, { taskId: 'actual-task-id' });
    expect(rendered).toContain('caller "caller"');
    expect(rendered).toContain('../tasks/subagents/actual-task-id/');
    expect(rendered).toContain('owner supplied instructions');
    expect(template.parameters).not.toHaveProperty('taskId');
  });

  it('rejects missing required prepared capabilities instead of applying legacy defaults during decode', () => {
    const prepared = prepareSubagentInput(declaration());
    for (const field of ['systemPrompt', 'tools', 'execution', 'toolProfile', 'budget', 'resultCapture'] as const) {
      const incomplete: Record<string, unknown> = { ...structuredClone(prepared) };
      delete incomplete[field];
      expect(() => decodeSubagentInput(incomplete)).toThrow(TypeError);
    }
  });

  it('uses a strict schema for unknown fields, functions and runtime-only dependency fields', () => {
    const prepared = prepareSubagentInput(declaration());
    expect(() => decodeSubagentInput({ ...prepared, taskQueue: 'not-subagent-state' })).toThrow(/unknown field/);
    expect(() => decodeSubagentInput({
      ...prepared,
      execution: { ...prepared.execution, credential: 'must-not-be-persisted' },
    })).toThrow(/unknown field/);
    expect(() => decodeSubagentInput({
      ...prepared,
      messages: [{ role: 'user', content: 'context', llmHandle: () => undefined }],
    })).toThrow(/JSON value/);
    expect(() => decodeSubagentInput({
      ...prepared,
      registry: { execute: () => undefined },
    })).toThrow(/JSON value/);
  });

  it('rejects non-canonical or internally inconsistent tools/context without silently rebuilding them', () => {
    const prepared = prepareSubagentInput(declaration());
    expect(() => decodeSubagentInput({
      ...prepared,
      tools: { manifest: { ...manifest, revision: 'stale-revision' } },
    })).toThrow(/not canonical|revision/);
    expect(() => decodeSubagentInput({
      ...prepared,
      tools: { manifest: { ...manifest, llmTools: [] } },
    })).toThrow(/definitions|provider tools/);
    expect(() => decodeSubagentInput({
      ...prepared,
      execution: { ...prepared.execution, manifestRevision: 'different-context' },
    })).toThrow(/must reference/);
    expect(() => decodeSubagentInput({
      ...prepared,
      messages: [{ role: 'user', content: 'context', unexpected: true }],
    })).toThrow(/unknown field/);
  });

  it('preserves and rejects unsupported input and template versions', () => {
    const prepared = prepareSubagentInput(declaration());
    const future = { ...structuredClone(prepared), schema_version: 2 };
    const before = JSON.stringify(future);
    expect(() => decodeSubagentInput(future)).toThrow(/unsupported PreparedSubagentInput schema_version: 2/);
    expect(JSON.stringify(future)).toBe(before);

    const futureTemplate = structuredClone(prepared);
    if (futureTemplate.systemPrompt.kind !== 'template') throw new TypeError('template fixture required');
    const templateWithFutureVersion = {
      ...futureTemplate,
      systemPrompt: { ...futureTemplate.systemPrompt, version: 2 },
    };
    const templateBefore = JSON.stringify(templateWithFutureVersion);
    expect(() => decodeSubagentInput(templateWithFutureVersion)).toThrow(/unsupported template version: 2/);
    expect(JSON.stringify(templateWithFutureVersion)).toBe(templateBefore);
  });
});
