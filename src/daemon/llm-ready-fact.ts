/**
 * @module L6.Daemon
 * Phase 1927 Step C：motion daemon ready 业务事实协议（LLM 身份发布/消费）。
 *
 * 协议面：
 * - 发布方（daemon.ts motion 分支）：Assembly 成功后的 activation 路径携带
 *   本进程实际消费的 LLM 配置身份摘要，经 PM opaque 业务事实 capability
 *   随 generation 目录整体 move 进 active（ready 可见 ⇒ 事实已存在）。
 * - 消费方（cli/commands/start.ts）：ensureRunning 三种 outcome
 *   （spawned/already_ready/joined）统一在 ready 后读 active generation 的
 *   本事实，与本次验证身份（verified.snapshot.identity）比对。
 * - fail-closed：无 active / 事实缺失（watchdog winner、旧 daemon）/ 解析
 *   失败 / generation 或 identity 不等，一律 typed MotionLLMIdentityMismatchError，
 *   start 不进 onboarding/chat。错误面不含 secret（identity 为 sha256 摘要）。
 */

import { formatErr } from '../foundation/node-utils/index.js';
import type { DaemonDir, ProcessManager, UpdateActiveBusinessFact } from '../foundation/process-manager/index.js';
import type { AppliedLLMIdentityPublishOutcome } from '../core/runtime/index.js';

/** 业务事实 schema 版本（版本不符按 malformed fail-closed）。 */
export const MOTION_LLM_READY_FACT_SCHEMA_VERSION = 1;

/** motion daemon 随 ready 发布的 LLM 身份事实（typed）。 */
export interface MotionLLMReadyFact {
  /** 发布本事实的 generation identity（须与 PM active generation 相等）。 */
  readonly generationId: string;
  /** 本 daemon 进程实际消费的 LLM 配置身份摘要（llmConfigIdentity）。 */
  readonly llmIdentity: string;
  /** 发布时间（ISO）。 */
  readonly committedAt: string;
}

/** 发布侧编码（JSON 单行；PM 存储不透明，内容解析归本模块）。 */
export function encodeMotionLLMReadyFact(fact: MotionLLMReadyFact): string {
  return JSON.stringify({ schema_version: MOTION_LLM_READY_FACT_SCHEMA_VERSION, ...fact });
}

type DecodedMotionLLMReadyFact =
  | { status: 'ok'; fact: MotionLLMReadyFact }
  | { status: 'malformed'; cause: string };

/** 消费侧解码（shape 校验；任何不符为 malformed，不抛）。 */
export function decodeMotionLLMReadyFact(raw: string): DecodedMotionLLMReadyFact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'malformed', cause: `json parse failed: ${formatErr(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'malformed', cause: 'fact is not an object' };
  }
  const rec = parsed as Record<string, unknown>;
  if (rec['schema_version'] !== MOTION_LLM_READY_FACT_SCHEMA_VERSION) {
    return { status: 'malformed', cause: `unsupported schema_version=${String(rec['schema_version'])}` };
  }
  if (typeof rec['generationId'] !== 'string' || rec['generationId'] === '') {
    return { status: 'malformed', cause: 'generationId missing or not a string' };
  }
  if (typeof rec['llmIdentity'] !== 'string' || rec['llmIdentity'] === '') {
    return { status: 'malformed', cause: 'llmIdentity missing or not a string' };
  }
  if (typeof rec['committedAt'] !== 'string' || rec['committedAt'] === '') {
    return { status: 'malformed', cause: 'committedAt missing or not a string' };
  }
  return {
    status: 'ok',
    fact: {
      generationId: rec['generationId'],
      llmIdentity: rec['llmIdentity'],
      committedAt: rec['committedAt'],
    },
  };
}

/** 消费侧失败分型（全部 fail-closed，无静默放行路径）。 */
export type MotionLLMIdentityFailure =
  /** PM 无 active generation（ready 后竞态 retire/replace）。 */
  | 'no_active_generation'
  /** active generation 无业务事实（watchdog winner / 旧 daemon 未发布）。 */
  | 'fact_missing'
  /** 事实读取失败或内容解析/shape 不符。 */
  | 'fact_malformed'
  /** 事实自称的 generation 与 PM active generation 不等。 */
  | 'generation_mismatch'
  /** 事实身份与本次验证身份不等（配置 A 的 daemon 不得服务验证 B 的 start）。 */
  | 'identity_mismatch';

/**
 * start 消费侧 typed 错误。message 只含 generation/identity 摘要，
 * 不含任何 secret（llmIdentity 为配置内容的 sha256 摘要）。
 */
export class MotionLLMIdentityMismatchError extends Error {
  readonly failure: MotionLLMIdentityFailure;
  constructor(failure: MotionLLMIdentityFailure, detail: string) {
    super(`motion daemon LLM identity check failed (${failure}): ${detail}`);
    this.name = 'MotionLLMIdentityMismatchError';
    this.failure = failure;
  }
}

/**
 * 消费侧确认：读 active generation 的 LLM 身份业务事实，与 expectedIdentity
 * 比对。任何缺口抛 MotionLLMIdentityMismatchError（fail-closed）；通过返回事实。
 *
 * 统一覆盖 spawned/already_ready/joined 三 outcome——调用方在 ensureRunning
 * resolve 后调用，无需区分 outcome 形态（PM 读 active 槽即 exact generation
 * 语义：generation 不等即 generation_mismatch）。
 */
export function ensureMotionLLMIdentity(
  pm: Pick<ProcessManager, 'readActiveBusinessFact'>,
  daemonDir: DaemonDir,
  expectedIdentity: string,
): MotionLLMReadyFact {
  const read = pm.readActiveBusinessFact(daemonDir);
  if (read.kind === 'no_active') {
    throw new MotionLLMIdentityMismatchError(
      'no_active_generation',
      'no active generation after ensureRunning resolved ready',
    );
  }
  if (read.kind === 'fact_missing') {
    throw new MotionLLMIdentityMismatchError(
      'fact_missing',
      `generation=${read.generationId} has no LLM identity fact (watchdog winner or pre-1927 daemon)`,
    );
  }
  if (read.kind === 'malformed') {
    throw new MotionLLMIdentityMismatchError('fact_malformed', formatErr(read.cause));
  }
  const decoded = decodeMotionLLMReadyFact(read.raw);
  if (decoded.status !== 'ok') {
    throw new MotionLLMIdentityMismatchError('fact_malformed', decoded.cause);
  }
  if (decoded.fact.generationId !== read.generationId) {
    throw new MotionLLMIdentityMismatchError(
      'generation_mismatch',
      `fact generation=${decoded.fact.generationId} != active generation=${read.generationId}`,
    );
  }
  if (decoded.fact.llmIdentity !== expectedIdentity) {
    throw new MotionLLMIdentityMismatchError(
      'identity_mismatch',
      `daemon identity=${decoded.fact.llmIdentity} != verified identity=${expectedIdentity}`,
    );
  }
  return decoded.fact;
}

// === 发布侧：热重载后刷新 active 事实（Phase 1945 Step C） ===

/**
 * 发布侧 typed 错误：PM 拒绝/失败时携带 PM typed kind，错误面只含摘要
 * （kind + cause），不含 secret。
 */
export class MotionLLMReadyFactPublishError extends Error {
  constructor(
    readonly kind: UpdateActiveBusinessFact['kind'],
    detail: string,
  ) {
    super(`motion LLM identity fact publish failed (${kind}): ${detail}`);
    this.name = 'MotionLLMReadyFactPublishError';
  }
}

function describePublishFailure(result: UpdateActiveBusinessFact): string {
  switch (result.kind) {
    case 'malformed_active':
    case 'retryable_failure':
      return formatErr(result.cause);
    default:
      return result.kind;
  }
}

/**
 * Phase 1945 Step C：motion daemon 的 applied identity 发布器工厂。
 * 热重载成功后由 Runtime 经注入面调用，把「本进程当前已应用」的 LLM 身份
 * 重写进 active generation 的业务事实（PM exact generation/pid 校验 + 原子写）。
 * 事实 schema 与出生事实同形；旧 raw 可读时解码出旧身份交还（审计前后链），
 * 不可解析归 malformed 分型、不阻断本次发布成功事实。
 */
export function createMotionLLMReadyFactPublisher(
  pm: Pick<ProcessManager, 'updateActiveBusinessFact'>,
  daemonDir: DaemonDir,
  binding: { generationId: string; pid: number },
): (identity: string) => Promise<AppliedLLMIdentityPublishOutcome> {
  return async (identity) => {
    const raw = encodeMotionLLMReadyFact({
      generationId: binding.generationId,
      llmIdentity: identity,
      committedAt: new Date().toISOString(),
    });
    const result = await pm.updateActiveBusinessFact(daemonDir, binding, raw);
    if (result.kind !== 'written') {
      throw new MotionLLMReadyFactPublishError(result.kind, describePublishFailure(result));
    }
    if (result.previousRaw === undefined) return { previousFact: 'missing' };
    const previous = decodeMotionLLMReadyFact(result.previousRaw);
    return previous.status === 'ok'
      ? { previousIdentity: previous.fact.llmIdentity, previousFact: 'ok' }
      : { previousFact: 'malformed' };
  };
}
