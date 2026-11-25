/**
 * Phase 2248 G4: Shadow-driven migration of its legacy ATS executor payloads.
 * ATS exposes only list/conditional-commit capabilities and never calls back here.
 */

import { decodeLegacyShadowPayload, prepareShadowInput } from './payload.js';
import type {
  ShadowTaskInputMigrationResult,
  ShadowTaskInputMigrationStore,
} from './types.js';

function commitErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? Reflect.get(error, 'code')
    : undefined;
}

/** One-shot owner scan; unrelated and damaged payloads are never silently executed. */
export async function migrateShadowTaskInputs(
  tasks: ShadowTaskInputMigrationStore,
): Promise<readonly ShadowTaskInputMigrationResult[]> {
  const results: ShadowTaskInputMigrationResult[] = [];
  for (const item of await tasks.listUnpreparedInputs()) {
    const decoded = decodeLegacyShadowPayload(item.payload);
    if (decoded.kind === 'not_applicable') {
      results.push({ kind: 'not_applicable', taskId: item.taskId });
      continue;
    }
    if (decoded.kind === 'invalid') {
      results.push({ kind: 'invalid', taskId: item.taskId, reason: decoded.reason });
      continue;
    }

    const input = prepareShadowInput(decoded.value);
    try {
      await tasks.commitPreparedInput({
        taskId: item.taskId,
        sourceHash: item.sourceHash,
        migrationSource: 'shadow_legacy_payload',
        input,
      });
      results.push({ kind: 'migrated', taskId: item.taskId, input });
    } catch (error) {
      const code = commitErrorCode(error);
      if (code === 'source_changed') {
        results.push({ kind: 'source_changed', taskId: item.taskId, cause: error });
        continue;
      }
      if (code === 'conflict' || code === 'active_execution') {
        results.push({ kind: 'conflict', taskId: item.taskId, code, cause: error });
        continue;
      }
      throw error;
    }
  }
  return results;
}
