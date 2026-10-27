import type { RootConfigAdmin } from '../../assembly/index.js';
import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import {
  discardLauncherCreatedCredentials,
  runLauncherSetupAttempt,
  type FirstRunDeps,
} from '../first-run-setup.js';
import { findSetupProvider, SETUP_PROVIDER_CATALOG } from '../setup-provider-catalog.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import {
  launcherSetupResponse,
  parseLauncherSetupRequest,
  type LauncherSetupRequest,
  type LauncherSetupResponse,
} from '../../cli-protocol/index.js';

const SESSION_PATH = 'launcher-setup-session.json';

type Session = {
  version: 1;
  sessionId: string;
  providerId: string;
  model?: string;
  apiKeyRef?: string;
  baseUrl?: string;
  createdCredentialRefs: string[];
  failure?: Record<string, unknown>;
};

export type LauncherSetupDeps = FirstRunDeps & {
  rootConfig: Pick<RootConfigAdmin, 'saveGlobalExclusive' | 'completeInitialization' | 'getInitializationState'>;
};

function catalog() {
  return SETUP_PROVIDER_CATALOG.map(choice => ({
    id: choice.id,
    label: choice.label,
    description: choice.description,
    auth: choice.auth,
    ...(choice.defaultModel !== undefined && { defaultModel: choice.defaultModel }),
    ...(choice.envVar !== undefined && { envVar: choice.envVar }),
  }));
}

function providerView(choice: NonNullable<ReturnType<typeof findSetupProvider>>) {
  return catalog().find(provider => provider.id === choice.id);
}

function needsProvider() {
  return { phase: 'needs_provider', catalog: catalog() };
}

async function readSession(deps: LauncherSetupDeps): Promise<Session | undefined> {
  try {
    const raw = await deps.fsFactory(getChestnutRoot()).read(SESSION_PATH);
    const value = JSON.parse(raw) as Partial<Session>;
    if (value.version !== 1 || typeof value.sessionId !== 'string' || typeof value.providerId !== 'string'
      || !findSetupProvider(value.providerId) || !Array.isArray(value.createdCredentialRefs)) {
      throw new Error('invalid launcher setup session');
    }
    return value as Session;
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
}

async function writeSession(deps: LauncherSetupDeps, session: Session): Promise<void> {
  const fs = deps.fsFactory(getChestnutRoot());
  await fs.writeAtomic(SESSION_PATH, `${JSON.stringify(session)}\n`);
  fs.chmodSync(SESSION_PATH, 0o600);
}

async function clearSession(deps: LauncherSetupDeps): Promise<void> {
  try {
    await deps.fsFactory(getChestnutRoot()).delete(SESSION_PATH);
  } catch (err) {
    if (!isFileNotFound(err)) throw err;
  }
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  }
  return value;
}

function stateForSession(session: Session): Record<string, unknown> {
  const choice = findSetupProvider(session.providerId)!;
  if (session.failure) {
    return {
      phase: 'repair',
      provider: providerView(choice),
      model: session.model,
      failure: session.failure,
      actions: ['retry', 'edit', 'cancel'],
    };
  }
  return {
    phase: 'needs_credentials',
    provider: providerView(choice),
    ...(session.model !== undefined && { model: session.model }),
    ...(choice.defaultModel !== undefined && { modelDefault: choice.defaultModel }),
  };
}

async function status(deps: LauncherSetupDeps): Promise<{ kind: 'state' | 'committed'; payload: Record<string, unknown> }> {
  const initialization = deps.rootConfig.getInitializationState();
  if (initialization === 'ready') return { kind: 'committed', payload: { phase: 'committed' } };
  if (initialization === 'invalid') throw new Error('Existing initialization is invalid; repair it with chestnut CLI');
  const session = await readSession(deps);
  return { kind: 'state', payload: session ? stateForSession(session) : needsProvider() };
}

function requiredString(request: LauncherSetupRequest, key: string): string {
  const value = request.payload?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalString(request: LauncherSetupRequest, key: string): string | undefined {
  const value = request.payload?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

export async function executeLauncherSetup(
  deps: LauncherSetupDeps,
  request: LauncherSetupRequest,
  audit?: AuditLog,
): Promise<LauncherSetupResponse> {
  const secrets = [optionalString(request, 'apiKey') ?? ''];
  try {
    if (request.action === 'status') {
      const result = await status(deps);
      return launcherSetupResponse(request.requestId, result.kind, result.payload);
    }
    if (deps.rootConfig.getInitializationState() === 'ready') {
      await clearSession(deps);
      return launcherSetupResponse(request.requestId, 'committed', { phase: 'committed' });
    }
    if (request.action === 'select_provider') {
      const previous = await readSession(deps);
      if (previous) await discardLauncherCreatedCredentials(deps, previous.createdCredentialRefs);
      const providerId = requiredString(request, 'providerId');
      const choice = findSetupProvider(providerId);
      if (!choice) throw new Error(`Unknown setup provider: ${providerId}`);
      const session: Session = {
        version: 1, sessionId: request.requestId, providerId, createdCredentialRefs: [],
      };
      await writeSession(deps, session);
      audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_RECONFIGURED, 'action=launcher_select_provider');
      return launcherSetupResponse(request.requestId, 'state', stateForSession(session));
    }
    const existing = await readSession(deps);
    if (request.action === 'cancel') {
      if (existing) await discardLauncherCreatedCredentials(deps, existing.createdCredentialRefs);
      await clearSession(deps);
      audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_SKIPPED, 'reason=launcher_cancel');
      return launcherSetupResponse(request.requestId, 'state', needsProvider());
    }
    if (!existing) throw new Error('No setup session; select a provider first');
    const choice = findSetupProvider(existing.providerId)!;
    if (request.action !== 'submit' && request.action !== 'retry') throw new Error('Unsupported setup action');
    const model = request.action === 'submit'
      ? (optionalString(request, 'model') ?? existing.model ?? choice.defaultModel ?? '')
      : (existing.model ?? '');
    const rawKey = request.action === 'submit' ? optionalString(request, 'apiKey') : undefined;
    const apiKey = rawKey || existing.apiKeyRef;
    const baseUrl = request.action === 'submit'
      ? (optionalString(request, 'baseUrl') ?? existing.baseUrl)
      : existing.baseUrl;
    const created = existing.createdCredentialRefs.flatMap((ref) => {
      // Values are resolved inside the shared credential owner during cleanup; only refs enter the session.
      return [{ ref, value: '' }];
    });
    const outcome = await runLauncherSetupAttempt(deps, { choice, model, ...(apiKey !== undefined && { apiKey }), ...(baseUrl !== undefined && { baseUrl }) }, created, audit);
    if (outcome.kind === 'repair') {
      const session: Session = {
        ...existing,
        model,
        ...(outcome.input.apiKey !== undefined && { apiKeyRef: outcome.input.apiKey }),
        ...(outcome.input.baseUrl !== undefined && { baseUrl: outcome.input.baseUrl }),
        createdCredentialRefs: created.map(entry => entry.ref),
        failure: redact(outcome.failure, secrets) as Record<string, unknown>,
      };
      await writeSession(deps, session);
      return launcherSetupResponse(request.requestId, 'state', stateForSession(session));
    }
    await clearSession(deps);
    return launcherSetupResponse(request.requestId, 'committed', { phase: 'committed', concurrent: outcome.kind === 'concurrent' });
  } catch (err) {
    const payload = redact({ phase: 'error', errorType: 'setup', message: formatErr(err), actions: ['edit', 'cancel'] }, secrets) as Record<string, unknown>;
    return launcherSetupResponse(request.requestId, 'error', payload);
  }
}

/** One JSONL request from stdin → exactly one JSONL response on stdout. Secrets never enter argv. */
export async function launcherSetupCommand(deps: LauncherSetupDeps, opts: { audit?: AuditLog } = {}): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  let requestId = 'unknown';
  try {
    const request = parseLauncherSetupRequest(input.trim());
    requestId = request.requestId;
    const response = await executeLauncherSetup(deps, request, opts.audit);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify(launcherSetupResponse(requestId, 'error', {
      phase: 'error', errorType: 'protocol', message: formatErr(err), actions: ['edit', 'cancel'],
    }))}\n`);
  }
}
