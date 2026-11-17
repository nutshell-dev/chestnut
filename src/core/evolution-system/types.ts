import type { ContractId } from '../contract/index.js';

/** Read-only lifecycle observation used by retrospective boot reconciliation. */
export type RetrospectiveContractObservation =
  | { kind: 'active'; contractId: ContractId }
  | {
      kind: 'completed_archived';
      contractId: ContractId;
      archivePath: string;
      completedAt: string | null;
      cause?: string;
    }
  | { kind: 'missing'; contractId: ContractId }
  | { kind: 'corrupt' | 'io_failed'; contractId: ContractId; error: string };

export type OrphanDisposition =
  | { kind: 'retired_archived' | 'already_retired'; outcomePath: string }
  | { kind: 'retry'; reason: 'missing' | 'corrupt' | 'io_failed'; nextAttemptAtMs: number }
  | { kind: 'resume'; contractId: ContractId };

/**
 * Durable evidence committed before a dispatching row may move to retired.
 * The original row bytes remain both here and in the retired row itself.
 */
export interface ArchivedOrphanOutcome {
  schema_version: 1;
  outcome: 'retired_archived';
  contract_id: ContractId;
  task_id: string;
  target_executor_id: string;
  created_at: string;
  contract_ref: string;
  archive_path: string;
  completed_at: string | null;
  observed_at: string;
  observation_source: 'contract_terminal_fact';
  dispatching_path: string;
  dispatching_sha256: string;
  dispatching_bytes: string;
  cause: string | null;
}

export type ArchivedOrphanEvidence = Pick<
  Extract<RetrospectiveContractObservation, { kind: 'completed_archived' }>,
  'archivePath' | 'completedAt' | 'cause'
>;
