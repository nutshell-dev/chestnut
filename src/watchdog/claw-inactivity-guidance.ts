/**
 * @module L6.Watchdog
 * phase 1258 Step A: Watchdog-owned `claw_inactivity` guidance codec.
 *
 * 业主 (watchdog) 独占 inactivity 事实分类与其持久化 wire schema：
 * - producer (watchdog-cron.fireInactivityNotification) 只经
 *   {@link encodeClawInactivityGuidance} 产生 `extraFields`，不再把任意
 *   content record 经 `Object.entries` 静默展开成 metadata（M#7/M#8）；
 * - consumer (assembly guidance composer) 只经 {@link decodeClawInactivityGuidance}
 *   读取 typed camelCase state，不再重复解释 wire / 不再自行 guard FailureClass。
 *
 * 与 claw_crashed 的差异（刻意不共享 generic helper）：
 * - claw identity 保留在 owner metadata `claw_id`（envelope `from` 固定
 *   `watchdog` = 通知发起模块的业务语义，不是目标 claw）；
 * - 普通 timeout 与 motion subscription 两条触发路径共用同一 schema，
 *   subscription 只多一个 typed literal optional `source_path='subscription'`。
 *
 * M#4: inbox 可跨中断恢复 → 显式 schema version + legacy read + unknown-version
 * failure 都是协议的一部分。当前 writer 总写 v1；decoder 同时接受 v1 与「缺
 * version 的现存 legacy production shape」（同一组 owned required fields），
 * 拒绝未知版本。
 *
 * 本文件保持纯函数、零 Watchdog runtime resource/import，供 Assembly composer
 * 以 protocol-only 方式 import（同 claw-failure-classes.ts 模式）。
 */

import type { FailureClass } from './claw-failure-classes.js';

/** 当前 writer 持久化的 schema version（string wire value）。 */
export const CLAW_INACTIVITY_GUIDANCE_SCHEMA_VERSION = '1' as const;

/** owner-local wire key（snake_case metadata key，仅此文件声明）。 */
const WIRE_KEYS = {
  version: 'guidance_schema_version',
  clawId: 'claw_id',
  failureClass: 'failure_class',
  inactiveMs: 'inactive_ms',
  contract: 'contract',
  asOf: 'as_of',
  sourcePath: 'source_path',
  lastError: 'last_error',
} as const;

/** subscription 触发辨识 — typed literal optional，不是任意 string dialect。 */
export type ClawInactivitySourcePath = 'subscription';

/** encoder 业务输入（typed / camelCase）。 */
export interface EncodeClawInactivityGuidanceInput {
  readonly clawId: string;
  readonly failureClass: FailureClass;
  /** 本次无活动时长（ms，非负 safe integer）。 */
  readonly inactiveMs: number;
  readonly contract: string;
  /** ISO 8601 timestamp（producer 固定 `new Date().toISOString()`，单次生成）。 */
  readonly asOf: string;
  /** 仅 subscription 触发路径写入；普通 timeout 缺失。 */
  readonly sourcePath?: ClawInactivitySourcePath;
  /** 最近错误（non-empty）；无错误时缺失（不混同空字符串）。 */
  readonly lastError?: string;
}

/** decoder 产出的 typed state（consumer 唯一依赖的稳定形状）。 */
export interface ClawInactivityGuidanceState {
  readonly schemaVersion: 1;
  readonly clawId: string;
  readonly failureClass: FailureClass;
  readonly inactiveMs: number;
  readonly contract: string;
  readonly asOf: string;
  readonly sourcePath?: ClawInactivitySourcePath;
  readonly lastError?: string;
}

/**
 * decoder 最小结构化入参 — 本地声明、禁止 import Assembly。
 * 与 Runtime `GuidanceEnvelope { type, from, meta }` structural 兼容。
 */
export interface ClawInactivityGuidanceWire {
  readonly type: string;
  readonly from: string;
  readonly meta: Readonly<Record<string, string>>;
}

export type ClawInactivityGuidanceDecodeErrorReason =
  | 'unknown_schema_version'
  | 'schema_invalid';

/**
 * malformed/unknown wire 的 typed error。
 * message 只含 type/version/field/reason，不回显 metadata 内容或 body。
 */
export class ClawInactivityGuidanceDecodeError extends Error {
  readonly reason: ClawInactivityGuidanceDecodeErrorReason;
  readonly field: string | undefined;

  constructor(
    reason: ClawInactivityGuidanceDecodeErrorReason,
    detail: string,
    field?: string,
  ) {
    super(`claw_inactivity guidance decode failed: reason=${reason}${field ? ` field=${field}` : ''} ${detail}`);
    this.name = 'ClawInactivityGuidanceDecodeError';
    this.reason = reason;
    this.field = field;
  }
}

const FAILURE_CLASSES: ReadonlySet<string> = new Set<FailureClass>([
  'daemon_silent',
  'daemon_errored',
]);

/** 明确 ISO 8601 约束（Date.parse 单独用会接受模糊日期）。 */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value: string): boolean {
  return ISO_8601_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * producer 侧 encode：typed 业务输入 → wire `extraFields`（总写 v1）。
 * envelope route（type/source）由 writer 固定，不经本函数。
 */
export function encodeClawInactivityGuidance(
  input: EncodeClawInactivityGuidanceInput,
): Readonly<Record<string, string>> {
  if (input.clawId.length === 0) {
    throw new Error('encodeClawInactivityGuidance: clawId must be non-empty');
  }
  if (!Number.isSafeInteger(input.inactiveMs) || input.inactiveMs < 0) {
    throw new Error('encodeClawInactivityGuidance: inactiveMs must be a non-negative safe integer');
  }
  if (!isIsoTimestamp(input.asOf)) {
    throw new Error('encodeClawInactivityGuidance: asOf must be an ISO 8601 timestamp');
  }
  if (input.lastError !== undefined && input.lastError.length === 0) {
    throw new Error('encodeClawInactivityGuidance: lastError must be non-empty when present');
  }
  return {
    [WIRE_KEYS.version]: CLAW_INACTIVITY_GUIDANCE_SCHEMA_VERSION,
    [WIRE_KEYS.clawId]: input.clawId,
    [WIRE_KEYS.failureClass]: input.failureClass,
    [WIRE_KEYS.inactiveMs]: String(input.inactiveMs),
    [WIRE_KEYS.contract]: input.contract,
    [WIRE_KEYS.asOf]: input.asOf,
    ...(input.sourcePath !== undefined ? { [WIRE_KEYS.sourcePath]: input.sourcePath } : {}),
    ...(input.lastError !== undefined ? { [WIRE_KEYS.lastError]: input.lastError } : {}),
  };
}

function requireField(
  meta: Readonly<Record<string, string>>,
  field: string,
): string {
  const value = meta[field];
  if (value === undefined || value.length === 0) {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', 'missing or empty required field', field);
  }
  return value;
}

/**
 * consumer 侧 decode：wire envelope → typed state。
 *
 * - version `'1'`：严格校验 owned fields；
 * - version 缺失：按同一旧 production shape 解析并返回 `schemaVersion: 1`；
 * - 其他 version：`unknown_schema_version`；
 * - `type !== 'claw_inactivity'`、`from !== 'watchdog'`（owner provenance）、
 *   未知 failure class、空 claw_id、非非负整数 inactive_ms、非法 ISO、
 *   `source_path` 非 `subscription`、optional 字段空值、缺 required field：
 *   `schema_invalid`；
 * - 额外 metadata key 不拒绝（owner 不预设 transport generic 扩展字段）。
 */
export function decodeClawInactivityGuidance(
  input: ClawInactivityGuidanceWire,
): ClawInactivityGuidanceState {
  if (input.type !== 'claw_inactivity') {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', `unexpected type=${input.type}`);
  }
  if (input.from !== 'watchdog') {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', 'unexpected source (envelope from)', 'from');
  }

  const meta = input.meta ?? {};
  const version = meta[WIRE_KEYS.version];
  if (version !== undefined && version !== CLAW_INACTIVITY_GUIDANCE_SCHEMA_VERSION) {
    throw new ClawInactivityGuidanceDecodeError(
      'unknown_schema_version',
      `version=${version}`,
      WIRE_KEYS.version,
    );
  }
  // version === '1' 严格校验；version 缺失按同一旧 production shape 解析（同组 owned required fields）

  const clawId = requireField(meta, WIRE_KEYS.clawId);

  const failureClassRaw = requireField(meta, WIRE_KEYS.failureClass);
  if (!FAILURE_CLASSES.has(failureClassRaw)) {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', 'unknown failure class', WIRE_KEYS.failureClass);
  }
  const failureClass = failureClassRaw as FailureClass;

  const inactiveMsRaw = requireField(meta, WIRE_KEYS.inactiveMs);
  if (!/^\d+$/.test(inactiveMsRaw)) {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', 'expected non-negative integer string', WIRE_KEYS.inactiveMs);
  }
  const inactiveMs = Number.parseInt(inactiveMsRaw, 10);
  if (!Number.isSafeInteger(inactiveMs)) {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', 'expected safe integer', WIRE_KEYS.inactiveMs);
  }

  const contract = requireField(meta, WIRE_KEYS.contract);

  const asOf = requireField(meta, WIRE_KEYS.asOf);
  if (!isIsoTimestamp(asOf)) {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', 'expected ISO 8601 timestamp', WIRE_KEYS.asOf);
  }

  const sourcePathRaw = meta[WIRE_KEYS.sourcePath];
  if (sourcePathRaw !== undefined && sourcePathRaw !== 'subscription') {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', `expected 'subscription'`, WIRE_KEYS.sourcePath);
  }
  const sourcePath = sourcePathRaw as ClawInactivitySourcePath | undefined;

  const lastErrorRaw = meta[WIRE_KEYS.lastError];
  if (lastErrorRaw !== undefined && lastErrorRaw.length === 0) {
    throw new ClawInactivityGuidanceDecodeError('schema_invalid', 'empty optional value', WIRE_KEYS.lastError);
  }
  const lastError = lastErrorRaw;

  return {
    schemaVersion: 1,
    clawId,
    failureClass,
    inactiveMs,
    contract,
    asOf,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}
