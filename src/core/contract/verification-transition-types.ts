/**
 * @module L4.ContractSystem.Verification.TransitionTypes
 * Phase 1136 Step A: strictly-typed verification attempt transitions.
 *
 * These types live in their own file to keep the verification cluster
 * decoupled from both public types.ts and repository internals.
 */

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
    }
  | {
      /**
       * Phase 1934 Step E（F-09）：执行无结论处置——释放 in_progress 回 todo，
       * 不增 retry_count、不写 last_failed_feedback、不触发 force_accept。
       * 与 interrupt 的差别仅在审计语义：中断是控制流取消，unavailable 是
       * 执行能力缺失（provider/工具/磁盘），二者都不消耗业务拒绝预算。
       */
      kind: 'unavailable';
      attemptId: string;
      at: string;
    };

