/**
 * LLMOrchestrator 长期实例健康状态。文件名、schema 与 raw IO 均归本模块；
 * 运行句柄、half-open、timer、inflight 与配置代次不进入此文件。
 */
import * as path from 'path';
import { formatErr } from '../node-utils/index.js';
import { isFileNotFound, type FileSystem } from '../fs/index.js';
import type { LLMErrorClass } from './errors.js';

export const LLM_INSTANCE_STATE_FILE = 'llm-instance-state.json' as const;

export interface LLMInstanceBreakerState {
  state: 'closed' | 'open';
  consecutiveFailures: number;
  openedAtMs?: number;
  lastFailureClass: LLMErrorClass | null;
}

export interface LLMInstanceSharedFailure {
  errorClass: LLMErrorClass;
  floorMs?: number;
}

export interface LLMInstanceProviderState {
  providerId: string;
  breaker: LLMInstanceBreakerState;
  sharedFailure?: LLMInstanceSharedFailure;
}

export interface LLMInstanceStateV1 {
  schema_version: 1;
  revision: number;
  updatedAt: string;
  providers: LLMInstanceProviderState[];
  lastSuccess: { providerId: string } | null;
}

export type LLMInstanceStateLoad =
  | { kind: 'missing' }
  | { kind: 'ok'; state: LLMInstanceStateV1 }
  | { kind: 'unusable'; reason: 'read_failed' | 'parse_failed' | 'schema_invalid'; detail: string };

const ERROR_CLASSES = new Set<LLMErrorClass>([
  'permanent', 'transient', 'rate_limit', 'abort', 'context_exceeded', 'quota', 'unknown',
]);

function instanceStatePath(stateDir = 'status'): string {
  return path.join(stateDir, LLM_INSTANCE_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isErrorClass(value: unknown): value is LLMErrorClass {
  return typeof value === 'string' && ERROR_CLASSES.has(value as LLMErrorClass);
}

function validateBreaker(value: unknown): value is LLMInstanceBreakerState {
  if (!isRecord(value)) return false;
  if (value.state !== 'closed' && value.state !== 'open') return false;
  if (!isNonNegativeInteger(value.consecutiveFailures)) return false;
  if (value.lastFailureClass !== null && !isErrorClass(value.lastFailureClass)) return false;
  if (value.openedAtMs !== undefined && !isNonNegativeNumber(value.openedAtMs)) return false;
  return value.state === 'open' ? value.openedAtMs !== undefined : value.openedAtMs === undefined;
}

function validateSharedFailure(value: unknown): value is LLMInstanceSharedFailure {
  if (!isRecord(value) || !isErrorClass(value.errorClass)) return false;
  return value.floorMs === undefined || isNonNegativeNumber(value.floorMs);
}

function validateState(value: unknown): value is LLMInstanceStateV1 {
  if (!isRecord(value) || value.schema_version !== 1) return false;
  if (!isNonNegativeInteger(value.revision)) return false;
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  if (!Array.isArray(value.providers)) return false;
  const ids = new Set<string>();
  for (const provider of value.providers) {
    if (!isRecord(provider) || typeof provider.providerId !== 'string' || provider.providerId.length === 0) return false;
    if (ids.has(provider.providerId) || !validateBreaker(provider.breaker)) return false;
    if (provider.sharedFailure !== undefined && !validateSharedFailure(provider.sharedFailure)) return false;
    ids.add(provider.providerId);
  }
  if (value.lastSuccess !== null) {
    if (!isRecord(value.lastSuccess) || typeof value.lastSuccess.providerId !== 'string') return false;
    if (value.lastSuccess.providerId.length === 0 || !ids.has(value.lastSuccess.providerId)) return false;
  }
  return true;
}

export function createEmptyLLMInstanceState(): LLMInstanceStateV1 {
  return {
    schema_version: 1,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    providers: [],
    lastSuccess: null,
  };
}

export function loadLLMInstanceState(fs: FileSystem, stateDir?: string): LLMInstanceStateLoad {
  let raw: string;
  try {
    raw = fs.readSync(instanceStatePath(stateDir));
  } catch (error) {
    if (isFileNotFound(error)) return { kind: 'missing' };
    return { kind: 'unusable', reason: 'read_failed', detail: formatErr(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'unusable', reason: 'parse_failed', detail: formatErr(error) };
  }
  if (!validateState(parsed)) {
    return { kind: 'unusable', reason: 'schema_invalid', detail: 'invalid LLM instance state V1' };
  }
  return { kind: 'ok', state: parsed };
}

export function saveLLMInstanceState(
  fs: FileSystem,
  state: LLMInstanceStateV1,
  stateDir?: string,
): ReturnType<FileSystem['writeAtomicSync']> {
  fs.ensureDirSync(stateDir ?? 'status');
  return fs.writeAtomicSync(instanceStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}
