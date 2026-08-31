/**
 * @module L4.ContractSystem.Verification.TransitionTypes
 * Phase 1136 Step A: strictly-typed verification attempt transitions.
 *
 * These types live in their own file to keep the verification cluster
 * decoupled from both public types.ts and repository internals.
 */

import type { SubtaskRuntimeRecord } from './types.js';

export type VerificationAttemptTransition =
  | {
      kind: 'start';
      attemptId: string;
      evidence: string;
      artifacts: string[];
      at: string;
    }
  | {
      kind: 'pass';
      attemptId: string;
      at: string;
    }
  | {
      kind: 'reject';
      attemptId: string;
      at: string;
      feedback: string;
      cause: 'llm_rejected' | 'script_failed' | 'programming_bug' | 'subagent_timeout';
      /**
       * Phase 1201 Step B: caller supplies the attempt budget; the queued
       * mutation computes forceAccept from the FRESH retry_count inside the
       * queue (retry_count + 1 >= maxAttempts), never from a pre-read snapshot.
       */
      maxAttempts: number;
    }
  | {
      kind: 'interrupt';
      attemptId: string;
      at: string;
      cause?: 'daemon_restart';
      feedback?: string;
    };

export interface VerificationTransitionSuccess {
  kind: 'updated';
  record: SubtaskRuntimeRecord;
  prior: SubtaskRuntimeRecord;
}

export interface VerificationTransitionSkipped {
  kind: 'skipped';
  reason: string;
}

export interface VerificationTransitionLate {
  kind: 'late';
  expectedAttemptId: string;
  actualAttemptId?: string;
}

export type VerificationTransitionResult =
  | VerificationTransitionSuccess
  | VerificationTransitionSkipped
  | VerificationTransitionLate;

export interface TransitionApplication {
  success: true;
  record: SubtaskRuntimeRecord;
}

export interface TransitionApplicationFailure {
  success: false;
  reason: string;
}

