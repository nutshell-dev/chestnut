/**
 * @module L6.Watchdog
 * phase 1257 Step A: Watchdog-owned `claw_crashed` guidance codec.
 *
 * 业主 (watchdog) 独占 crash 事实分类与其持久化 wire schema：
 * - producer (watchdog-cron.maybeCronClawCrash) 只经 {@link encodeClawCrashedGuidance}
 *   产生 `source + extraFields`，不再 inline 手写 metadata key；
 * - consumer (assembly guidance composer) 只经 {@link decodeClawCrashedGuidance}
 *   读取 typed camelCase state，不再重复解释 wire / 不再自行 guard CrashClass。
 *
 * M#4: inbox 可跨中断恢复 → 显式 schema version + legacy read + unknown-version failure
 * 都是协议的一部分。当前 writer 总写 v1；decoder 同时接受 v1 与「缺 version 的现存
 * legacy production shape」（同一组 owned required fields），拒绝未知版本。
 *
 * M#8: claw identity 只经 envelope `from` 传递，不复制进 metadata（无 claw_id key）。
 *
 * 本文件保持纯函数、零 Watchdog runtime resource/import，供 Assembly composer
 * 以 protocol-only 方式 import（同 claw-failure-classes.ts 模式）。
 */

import type { CrashClass } from './claw-failure-classes.js';

/** 当前 writer 持久化的 schema version（string wire value）。 */
export const CLAW_CRASHED_GUIDANCE_SCHEMA_VERSION = '1' as const;

/** owner-local wire key（snake_case metadata key，仅此文件声明）。 */
const WIRE_KEYS = {
  version: 'guidance_schema_version',
  crashClass: 'crash_class',
  cleanStopMarker: 'clean_stop_marker',
  contract: 'contract',
  outboxPending: 'outbox_pending',
  asOf: 'as_of',
} as const;

/** encoder 业务输入（typed / camelCase）。 */
export interface EncodeClawCrashedGuidanceInput {
  readonly clawId: string;
  readonly crashClass: CrashClass;
  readonly cleanStopMarker: boolean;
  readonly contract: string;
  /**
   * outbox pending 计数。生产实然包含 `-1` sentinel（gatherClawSnapshot outbox
   * 读失败时），因此协议接受任意整数、不Clamp / 不静默改写（信息不丢失）。
   */
  readonly outboxPending: number;
  /** ISO 8601 timestamp（producer 固定 `new Date().toISOString()`）。 */
  readonly asOf: string;
}

/** decoder 产出的 typed state（consumer 唯一依赖的稳定形状）。 */
export interface ClawCrashedGuidanceState {
  readonly schemaVersion: 1;
  readonly clawId: string;
  readonly crashClass: CrashClass;
  readonly cleanStopMarker: boolean;
  readonly contract: string;
  readonly outboxPending: number;
  readonly asOf: string;
}

/**
 * decoder 最小结构化入参 — 本地声明、禁止 import Assembly。
 * 与 Runtime `GuidanceEnvelope { type, from, meta }` structural 兼容。
 */
export interface ClawCrashedGuidanceWire {
  readonly type: string;
  readonly from: string;
  readonly meta: Readonly<Record<string, string>>;
}

export type ClawCrashedGuidanceDecodeErrorReason =
  | 'unknown_schema_version'
  | 'schema_invalid';

/**
 * malformed/unknown wire 的 typed error。
 * message 只含 type/version/field/reason，不回显完整 metadata 或 body。
 */
export class ClawCrashedGuidanceDecodeError extends Error {
  readonly reason: ClawCrashedGuidanceDecodeErrorReason;
  readonly field: string | undefined;

  constructor(
    reason: ClawCrashedGuidanceDecodeErrorReason,
    detail: string,
    field?: string,
  ) {
    super(`claw_crashed guidance decode failed: reason=${reason}${field ? ` field=${field}` : ''} ${detail}`);
    this.name = 'ClawCrashedGuidanceDecodeError';
    this.reason = reason;
    this.field = field;
  }
}

const CRASH_CLASSES: ReadonlySet<string> = new Set<CrashClass>([
  'active_unexpected',
  'active_user_stopped',
]);

/** 明确 ISO 8601 约束（Date.parse 单独用会接受模糊日期）。 */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value: string): boolean {
  return ISO_8601_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** producer 侧 encode：typed 业务输入 → wire `source + extraFields`（总写 v1）。 */
export function encodeClawCrashedGuidance(
  input: EncodeClawCrashedGuidanceInput,
): {
  readonly source: string;
  readonly extraFields: Readonly<Record<string, string>>;
} {
  if (input.clawId.length === 0) {
    throw new Error('encodeClawCrashedGuidance: clawId must be non-empty');
  }
  if (!Number.isInteger(input.outboxPending)) {
    throw new Error('encodeClawCrashedGuidance: outboxPending must be an integer');
  }
  if (!isIsoTimestamp(input.asOf)) {
    throw new Error('encodeClawCrashedGuidance: asOf must be an ISO 8601 timestamp');
  }
  return {
    source: input.clawId,
    extraFields: {
      [WIRE_KEYS.version]: CLAW_CRASHED_GUIDANCE_SCHEMA_VERSION,
      [WIRE_KEYS.crashClass]: input.crashClass,
      [WIRE_KEYS.cleanStopMarker]: String(input.cleanStopMarker),
      [WIRE_KEYS.contract]: input.contract,
      [WIRE_KEYS.outboxPending]: String(input.outboxPending),
      [WIRE_KEYS.asOf]: input.asOf,
    },
  };
}

function requireField(
  meta: Readonly<Record<string, string>>,
  field: string,
): string {
  const value = meta[field];
  if (value === undefined || value.length === 0) {
    throw new ClawCrashedGuidanceDecodeError('schema_invalid', 'missing or empty required field', field);
  }
  return value;
}

/**
 * consumer 侧 decode：wire envelope → typed state。
 *
 * - version `'1'`：严格校验 owned required fields；
 * - version 缺失：按同一旧 production shape 解析并返回 `schemaVersion: 1`；
 * - 其他 version：`unknown_schema_version`；
 * - `type !== 'claw_crashed'`、空 `from`、未知 crash class、非 `true|false`、
 *   非整数字符串、非法 ISO 或缺字段：`schema_invalid`；
 * - 额外 metadata key 不拒绝（owner 不预设 transport generic 扩展字段）。
 */
export function decodeClawCrashedGuidance(
  input: ClawCrashedGuidanceWire,
): ClawCrashedGuidanceState {
  if (input.type !== 'claw_crashed') {
    throw new ClawCrashedGuidanceDecodeError('schema_invalid', `unexpected type=${input.type}`);
  }
  const clawId = input.from;
  if (typeof clawId !== 'string' || clawId.length === 0) {
    throw new ClawCrashedGuidanceDecodeError('schema_invalid', 'empty source (envelope from)', 'from');
  }

  const meta = input.meta ?? {};
  const version = meta[WIRE_KEYS.version];
  if (version !== undefined && version !== CLAW_CRASHED_GUIDANCE_SCHEMA_VERSION) {
    throw new ClawCrashedGuidanceDecodeError(
      'unknown_schema_version',
      `version=${version}`,
      WIRE_KEYS.version,
    );
  }
  // version === '1' 严格校验；version 缺失按同一旧 production shape 解析（同组 owned required fields）

  const crashClassRaw = requireField(meta, WIRE_KEYS.crashClass);
  if (!CRASH_CLASSES.has(crashClassRaw)) {
    throw new ClawCrashedGuidanceDecodeError('schema_invalid', 'unknown crash class', WIRE_KEYS.crashClass);
  }
  const crashClass = crashClassRaw as CrashClass;

  const cleanStopRaw = requireField(meta, WIRE_KEYS.cleanStopMarker);
  if (cleanStopRaw !== 'true' && cleanStopRaw !== 'false') {
    throw new ClawCrashedGuidanceDecodeError('schema_invalid', `expected 'true'|'false'`, WIRE_KEYS.cleanStopMarker);
  }
  const cleanStopMarker = cleanStopRaw === 'true';

  const contract = requireField(meta, WIRE_KEYS.contract);

  const outboxPendingRaw = requireField(meta, WIRE_KEYS.outboxPending);
  if (!/^-?\d+$/.test(outboxPendingRaw)) {
    throw new ClawCrashedGuidanceDecodeError('schema_invalid', 'expected integer string', WIRE_KEYS.outboxPending);
  }
  const outboxPending = Number.parseInt(outboxPendingRaw, 10);

  const asOf = requireField(meta, WIRE_KEYS.asOf);
  if (!isIsoTimestamp(asOf)) {
    throw new ClawCrashedGuidanceDecodeError('schema_invalid', 'expected ISO 8601 timestamp', WIRE_KEYS.asOf);
  }

  return {
    schemaVersion: 1,
    clawId,
    crashClass,
    cleanStopMarker,
    contract,
    outboxPending,
    asOf,
  };
}
