/** Compile-time brand field — prevents structural matching of plain `{ write: ... }` mocks. */
export interface AuditLog {
  readonly __brand: 'AuditLog';
  write(type: string, ...cols: (string | number)[]): void;
  dispose?(): void;
  /** Truncate s to AUDIT_PREVIEW_LEN (100) — short raw preview, "glance" level. */
  preview(s: string): string;
  /** Truncate s to AUDIT_MESSAGE_MAX_CHARS (200) — mid context, error / reason / command. */
  message(s: string): string;
  /** Truncate s to SUMMARY_MAX_CHARS (500) — long content summary, tool_result preview level. */
  summary(s: string): string;
  /** Encode a typed reference to an owner-persisted authoritative artifact. */
  artifact(ref: AuditArtifactRef): string[];
  /** Encode an explicit information-loss policy, optionally linked to an artifact. */
  loss(record: AuditLossRecord): string[];
}

/**
 * phase 1765 (Phase 1764 冻结设计): AuditWriter 主 append 路径的 durability outcome。
 *
 * - `durable`：append + sync 均成功。
 * - `committed_platform_limited`：append 已提交（page-cache 可见）但 sync 失败；
 *   携带原始 sync error / path / row identity（完整 TSV 行，含 ts+seq+type）。
 *   不得伪装成功；fallback/retry 责任由 AuditWriter owner 统一承接，
 *   调用者不得自行猜测或重复写入（重复 append 会致 reconcile 双份）。
 * - `pending_fallback`：append 本身失败，row 已进模块级 fallback 池
 *   （dump/reconcile/drop counter 通道观测），同样保留 error 与 row identity。
 *
 * 仅 AuditWriter（及 DispatchingAuditWriter 透传）结构化返回；AuditLog 接口
 * 的 `write` 保持 void（协变拓宽合法），经接口调用的 caller 不观测 outcome。
 */
export type AuditWriteOutcome =
  | { kind: 'durable' }
  | { kind: 'committed_platform_limited'; path: string; row: string; error: unknown }
  | { kind: 'pending_fallback'; path: string; row: string; error: unknown };

export interface AuditArtifactRef {
  owner: string;
  ref: string;
  sha256: string;
  bytes: number;
  schemaVersion: number;
  partial: boolean;
}

export interface AuditLossRecord {
  source: string;
  amount: number;
  unit: 'bytes' | 'chars' | 'rows' | 'blocks' | 'events';
  reason: string;
  policyVersion: number;
  recoverable: boolean;
  artifact?: AuditArtifactRef;
}

/**
 * TraceId brand type (phase 140 立、phase 136 §5.B invariant 6 应然推导).
 *
 * SoT: runtime turn 起点 (phase 1343 α-6). 因 architecture 约束（foundation 层不可反向依赖 core 层），
 * 将 brand 类型定义放在 audit 模块 types.ts，由 runtime 通过 foundation/audit 消费。
 *
 * 形态: 16-byte hex（如 7b922f1afc4859e5）
 *
 * Invariants:
 * - 模块外不可造（__brand 编译期 check）
 * - runtime 等价 string（audit emit cols 字面不变、M#7 + phase 393 跨进程契约）
 */
export type TraceId = string & { readonly __brand: 'TraceId' };

export function makeTraceId(raw: string): TraceId {
  if (!raw || typeof raw !== 'string') {
    throw new Error(`makeTraceId: expected non-empty string, got ${typeof raw}`);
  }
  return raw as TraceId;
}

/**
 * Phase 140: per-ID-dimension naming mapping entry.
 *
 * Owned by each module (the "owner" of the corresponding ID dimension) and
 * aggregated at the assembly layer. Moved here to avoid L1-L4 modules
 * importing from L6 assembly.
 */
export interface IdNamingEntry {
  /** snake_case audit.tsv column name */
  readonly auditCol: string;
  /** snake_case dialog metadata field, or null if not stored in dialog */
  readonly dialogMeta: string | null;
  /** camelCase TypeScript field / brand type name */
  readonly tsField: string;
  /** kebab-case CLI flag fragment (or parenthetical note if implicit) */
  readonly cliFlag: string;
}

/**
 * Phase 1243: audit file routing contribution protocol.
 * Owner modules declare `{ eventType: fileName }` records; Assembly aggregates them.
 */
export type AuditFileName = 'audit' | 'tick' | 'viewport';

export type AuditFileRoutingContribution = Readonly<Record<string, AuditFileName>>;

/**
 * Phase 140: per-event column schema entry for snapshot.json.
 */
export interface ColSchemaEntry {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean';
  readonly required: boolean;
  readonly max_chars?: number;
}
