import { LAUNCHER_PROTOCOL_VERSION_V2 } from './launcher-envelope.js';

export const LAUNCHER_COMMANDS = ['status', 'setup', 'start', 'send', 'stream'] as const;
export type LauncherCommand = (typeof LAUNCHER_COMMANDS)[number];

export interface LauncherCapabilities {
  protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2;
  commands: readonly LauncherCommand[];
  resync: 'snapshot';
  languageMode: 'prompt_or_auto';
}

export const LAUNCHER_CAPABILITIES: LauncherCapabilities = {
  protocol: LAUNCHER_PROTOCOL_VERSION_V2,
  commands: LAUNCHER_COMMANDS,
  resync: 'snapshot',
  languageMode: 'prompt_or_auto',
};

interface LauncherRequestBase {
  protocol?: typeof LAUNCHER_PROTOCOL_VERSION_V2;
  requestId?: string;
}

export interface LauncherStatusRequest extends LauncherRequestBase {
  command?: 'status';
}

export interface LauncherStartRequest extends LauncherRequestBase {
  command?: 'start';
  timeoutMs?: number;
  /** CLI-style language sample; omitted/empty means auto. */
  languageSample?: string;
}

export interface LauncherSendRequest extends LauncherRequestBase {
  command?: 'send';
  requestId: string;
  text: string;
}

export interface LauncherStreamRequest extends LauncherRequestBase {
  command?: 'stream';
  afterSequence?: number;
}

export type LauncherCommandRequest =
  | LauncherStatusRequest
  | LauncherStartRequest
  | LauncherSendRequest
  | LauncherStreamRequest;

function parseObject(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('launcher request must be an object');
  }
  const request = value as Record<string, unknown>;
  if (request.protocol !== undefined && request.protocol !== LAUNCHER_PROTOCOL_VERSION_V2) {
    throw new Error(`unsupported launcher protocol: ${String(request.protocol)}`);
  }
  if (request.requestId !== undefined && (typeof request.requestId !== 'string' || !request.requestId)) {
    throw new Error('requestId must be a non-empty string');
  }
  return request;
}

function assertCommand(request: Record<string, unknown>, expected: LauncherCommand): void {
  if (request.command !== undefined && request.command !== expected) {
    throw new Error(`expected launcher command ${expected}`);
  }
}

export function parseLauncherStatusRequest(line: string): LauncherStatusRequest {
  const request = parseObject(line);
  assertCommand(request, 'status');
  return request as LauncherStatusRequest;
}

export function parseLauncherStartRequest(line: string): LauncherStartRequest {
  const request = parseObject(line);
  assertCommand(request, 'start');
  if (request.languageSample !== undefined && typeof request.languageSample !== 'string') {
    throw new Error('languageSample must be a string');
  }
  if (request.timeoutMs !== undefined
    && (!Number.isInteger(request.timeoutMs) || (request.timeoutMs as number) <= 0)) {
    throw new Error('timeoutMs must be a positive integer');
  }
  return request as LauncherStartRequest;
}

export function parseLauncherSendRequest(line: string): LauncherSendRequest {
  const request = parseObject(line);
  assertCommand(request, 'send');
  if (typeof request.requestId !== 'string' || !request.requestId) throw new Error('requestId is required');
  if (typeof request.text !== 'string' || !request.text.trim()) throw new Error('text is required');
  return request as unknown as LauncherSendRequest;
}

export function parseLauncherStreamRequest(line: string): LauncherStreamRequest {
  const request = parseObject(line);
  assertCommand(request, 'stream');
  if (request.afterSequence !== undefined
    && (!Number.isInteger(request.afterSequence) || (request.afterSequence as number) < 0)) {
    throw new Error('afterSequence must be a non-negative integer');
  }
  return request as LauncherStreamRequest;
}
