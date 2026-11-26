/**
 * @module L3.SubAgent.ResultDirQuery
 * SubAgent result-directory layout and read-only lifecycle observation.
 *
 * The CLI supplies a claw-relative result directory; this owner module is the
 * only layer that interprets the private execution record schema. Querying
 * replays committed records and never acquires a claim, starts or resumes work.
 */
import * as path from 'node:path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { TASKS_SYNC_SUBAGENT_DIR, TASKS_SUBAGENTS_DIR, SUBAGENT_EXECUTION_DIR } from './constants.js';
import { projectExecutionCorrelation, type SubagentExecutionCorrelation } from './execution-correlation.js';
import {
  normalizeSubagentLocation,
  SubagentExecutionStore,
  SubagentExecutionStoreError,
} from './execution-store.js';
import type {
  SubagentExecutionIdentity,
  SubagentExecutionLocation,
  SubagentExecutionQuery,
  SubagentExecutionView,
} from './execution-types.js';

/** owner 命名空间探测顺序（sync → legacy；与历史 CLI 探测顺序一致）。 */
const SUBAGENT_RUN_DIRS = [TASKS_SYNC_SUBAGENT_DIR, TASKS_SUBAGENTS_DIR] as const;

/** 按 id 探测 subagent run 结果目录（首个命名空间命中即返回；未命中 null）。 */
export function resolveSubagentRunDir(
  fs: Pick<FileSystem, 'existsSync'>,
  id: string,
): string | null {
  for (const dir of SUBAGENT_RUN_DIRS) {
    const rel = `${dir}/${id}`;
    if (fs.existsSync(rel)) return rel;
  }
  return null;
}

type SubagentResultDirObservationBase = SubagentExecutionLocation;

export type SubagentResultDirObservation =
  | (SubagentResultDirObservationBase & {
      readonly kind: 'found';
      readonly identity: SubagentExecutionIdentity;
      readonly view: SubagentExecutionView;
      readonly correlation: SubagentExecutionCorrelation;
    })
  | (SubagentResultDirObservationBase & {
      readonly kind: 'legacy';
      readonly artifacts: readonly string[];
    })
  | (SubagentResultDirObservationBase & { readonly kind: 'not_found' })
  | (SubagentResultDirObservationBase & {
      readonly kind: 'corrupt';
      readonly path?: string;
      readonly reason: string;
    });

function corruptObservation(
  location: SubagentExecutionLocation,
  error: unknown,
): SubagentResultDirObservation {
  return {
    kind: 'corrupt',
    ...location,
    ...(error instanceof SubagentExecutionStoreError && error.recordPath ? { path: error.recordPath } : {}),
    reason: formatErr(error),
  };
}

/**
 * Read the latest (or explicitly selected) execution attempt without exposing
 * the store's private documents or any execution-control capability.
 */
export async function querySubagentExecution(
  fs: FileSystem,
  query: SubagentExecutionQuery,
): Promise<SubagentResultDirObservation> {
  let location: SubagentExecutionLocation;
  try {
    location = normalizeSubagentLocation(query);
  } catch (error) {
    // silent: returned verbatim as an explicit corrupt observation for the caller.
    return corruptObservation(query, error);
  }
  const store = new SubagentExecutionStore({ fs, resultDir: location.resultDir });
  try {
    const read = await store.read(location.runId, query.attemptId);
    if (read.kind === 'found') {
      return {
        kind: 'found',
        ...location,
        identity: read.view.identity,
        view: read.view,
        correlation: projectExecutionCorrelation(read.input.input),
      };
    }
    if (read.kind === 'corrupt') {
      return {
        kind: 'corrupt',
        ...location,
        ...(read.path ? { path: read.path } : {}),
        reason: read.reason,
      };
    }

    const executionDir = path.join(location.resultDir, SUBAGENT_EXECUTION_DIR);
    if (await store.exists(executionDir)) {
      // A requested attempt may legitimately be absent. A latest-attempt query
      // reaching this branch means execution metadata exists but is incomplete.
      if (query.attemptId !== undefined) return { kind: 'not_found', ...location };
      return {
        kind: 'corrupt',
        ...location,
        path: executionDir,
        reason: 'execution metadata exists but its latest attempt is not readable',
      };
    }
    if (!(await store.exists(location.resultDir))) return { kind: 'not_found', ...location };

    const candidates = ['recovery/cursor.json', 'messages.json', 'result.txt', 'stream.jsonl', 'audit.tsv'];
    const artifacts: string[] = [];
    for (const candidate of candidates) {
      if (await store.exists(path.join(location.resultDir, candidate))) artifacts.push(candidate);
    }
    // An existing old result directory is legacy even if no known artifact remains.
    return { kind: 'legacy', ...location, artifacts };
  } catch (error) {
    // silent: returned verbatim as an explicit corrupt observation for the caller.
    return corruptObservation(location, error);
  }
}
