import { describe, expect, it } from 'vitest';
import {
  ExecutionInputStoreError,
  makeFullTaskId,
  type CommitPreparedExecutionInput,
  type FullTaskId,
  type UnpreparedExecutionInput,
} from '../../../src/core/async-task-system/index.js';
import {
  migrateShadowTaskInputs,
  type ShadowExecutorPayload,
  type ShadowTaskInputMigrationStore,
} from '../../../src/core/shadow-system/index.js';
import { createCanonicalToolManifestFromDefinitions } from '../../../src/foundation/tools/index.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';

const tools: ToolDefinition[] = [{
  name: 'read',
  description: 'read',
  input_schema: { type: 'object', properties: {} },
}];
const manifest = createCanonicalToolManifestFromDefinitions(tools);
const ids = [
  '550e8400-e29b-41d4-a716-446655440001',
  '550e8400-e29b-41d4-a716-446655440002',
  '550e8400-e29b-41d4-a716-446655440003',
  '550e8400-e29b-41d4-a716-446655440004',
].map(makeFullTaskId);

function legacyPayload(shadowId = 'shadow-legacy'): ShadowExecutorPayload {
  return {
    systemPrompt: 'frozen parent prompt',
    messages: [{ role: 'user', content: 'frozen Shadow instruction' }],
    toolsForLLM: tools,
    manifestRevision: manifest.revision,
    promptRevision: 'parent-prompt-revision',
    identity: { shadowId, originClawId: 'origin', isShadow: true },
    detached: true,
    budget: { timeoutMs: 30_000, maxSteps: 9, idleTimeoutMs: 500 },
  };
}

function item(taskId: FullTaskId, payload: unknown): UnpreparedExecutionInput {
  return {
    kind: 'needs_owner_migration',
    taskId,
    sourcePath: `tasks/queues/pending/${taskId}.json`,
    sourceHash: `source-${taskId.slice(-1)}`,
    payload,
  };
}

function harness(
  items: readonly UnpreparedExecutionInput[],
  failures: ReadonlyMap<FullTaskId, ExecutionInputStoreError> = new Map(),
) {
  const commits: CommitPreparedExecutionInput[] = [];
  const store: ShadowTaskInputMigrationStore = {
    listUnpreparedInputs: async () => items,
    commitPreparedInput: async request => {
      commits.push(request);
      const failure = failures.get(request.taskId);
      if (failure) throw failure;
      return { schema_version: 1 as const, ...request };
    },
  };
  return { commits, store };
}

describe('Shadow legacy task input migration (phase 2248 G4)', () => {
  it('migrates only valid Shadow payloads and reports unknown and damaged records separately', async () => {
    const valid = item(ids[0], legacyPayload());
    const unknown = item(ids[1], { owner: 'another-system', payload: { keep: true } });
    const damaged = item(ids[2], { ...legacyPayload('shadow-damaged'), messages: null });
    const { commits, store } = harness([valid, unknown, damaged]);

    const results = await migrateShadowTaskInputs(store);

    expect(results.map(result => result.kind)).toEqual(['migrated', 'not_applicable', 'invalid']);
    expect(results[0]).toMatchObject({
      taskId: ids[0],
      input: {
        prompt: '',
        systemPrompt: { kind: 'text', text: 'frozen parent prompt' },
        toolProfile: 'full',
        execution: { callerKind: 'shadow', manifestRevision: manifest.revision },
        resultCapture: { toolName: 'done' },
      },
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      taskId: ids[0],
      sourceHash: valid.sourceHash,
      migrationSource: 'shadow_legacy_payload',
    });
  });

  it('distinguishes source changes from publication and active-execution conflicts', async () => {
    const sourceError = new ExecutionInputStoreError('source_changed', 'source changed');
    const conflictError = new ExecutionInputStoreError('conflict', 'winner retained');
    const activeError = new ExecutionInputStoreError('active_execution', 'already active');
    const { commits, store } = harness(
      [item(ids[0], legacyPayload('s1')), item(ids[1], legacyPayload('s2')), item(ids[2], legacyPayload('s3'))],
      new Map([[ids[0], sourceError], [ids[1], conflictError], [ids[2], activeError]]),
    );

    const results = await migrateShadowTaskInputs(store);

    expect(commits).toHaveLength(3);
    expect(results).toEqual([
      { kind: 'source_changed', taskId: ids[0], cause: sourceError },
      { kind: 'conflict', taskId: ids[1], code: 'conflict', cause: conflictError },
      { kind: 'conflict', taskId: ids[2], code: 'active_execution', cause: activeError },
    ]);
  });

  it('preserves unexpected commit failures rather than relabelling them as not applicable', async () => {
    const failure = new Error('storage unavailable');
    const { store } = harness([item(ids[0], legacyPayload())]);
    store.commitPreparedInput = async () => { throw failure; };

    await expect(migrateShadowTaskInputs(store)).rejects.toBe(failure);
  });
});
