/** Versioned, secret-safe wire contract for launcher's first-run setup adapter. */
export const LAUNCHER_SETUP_PROTOCOL = 'chestnut.launcher.setup.v1' as const;

export type LauncherSetupAction = 'status' | 'select_provider' | 'submit' | 'retry' | 'cancel';

export interface LauncherSetupRequest {
  protocolVersion: typeof LAUNCHER_SETUP_PROTOCOL;
  requestId: string;
  action: LauncherSetupAction;
  payload?: Record<string, unknown>;
}

export interface LauncherSetupResponse {
  protocolVersion: typeof LAUNCHER_SETUP_PROTOCOL;
  requestId: string;
  kind: 'state' | 'probe' | 'committed' | 'error';
  payload: Record<string, unknown>;
}

const ACTIONS: readonly LauncherSetupAction[] = ['status', 'select_provider', 'submit', 'retry', 'cancel'];

export function parseLauncherSetupRequest(line: string): LauncherSetupRequest {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('setup request must be an object');
  const request = value as Record<string, unknown>;
  if (request.protocolVersion !== LAUNCHER_SETUP_PROTOCOL) throw new Error('unsupported setup protocolVersion');
  if (typeof request.requestId !== 'string' || !request.requestId) throw new Error('requestId is required');
  if (typeof request.action !== 'string' || !ACTIONS.includes(request.action as LauncherSetupAction)) {
    throw new Error('unknown setup action');
  }
  if (request.payload !== undefined && (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload))) {
    throw new Error('payload must be an object');
  }
  return request as unknown as LauncherSetupRequest;
}

export function launcherSetupResponse(
  requestId: string,
  kind: LauncherSetupResponse['kind'],
  payload: Record<string, unknown>,
): LauncherSetupResponse {
  return { protocolVersion: LAUNCHER_SETUP_PROTOCOL, requestId, kind, payload };
}
