import { formatErr } from '../node-utils/index.js';
import { isFileNotFound, type FileSystem } from '../fs/index.js';
import type {
  ProcessEvidence,
  ProcessRefCapture,
  ProcessUnavailableReason,
} from '../process-exec/index.js';

export type ClaimChannel = 'inbox' | 'outbox';

export type ClaimRecordCapture =
  | { kind: 'captured'; value: unknown; evidence: ProcessEvidence }
  | Exclude<ProcessRefCapture, { kind: 'captured' }>;

/** Private Messaging schema; process references remain unbranded until L1 decodes them. */
export type ClaimDescriptor = {
  version: 1;
  claimId: string;
  channel: ClaimChannel;
  originalName: string;
  claimName: string;
  createdAtMs: number;
  capture: ClaimRecordCapture;
  [key: string]: unknown;
};

export type ClaimRecordIssue = {
  kind: 'missing' | 'io' | 'invalid' | 'unsupported';
  detail: string;
  code?: string;
};

export type ClaimRecordEvidence = {
  recordPath?: string;
  raw?: string;
  issue?: ClaimRecordIssue;
};

type ClaimRecordErrorOptions = {
  recordPath?: string;
  raw?: string;
  cause?: unknown;
};

export class ClaimRecordUnavailableError extends Error {
  readonly code = 'CLAIM_RECORD_UNAVAILABLE' as const;
  readonly rawName: string;
  readonly recordPath?: string;
  readonly raw?: string;

  constructor(
    public readonly entry: string,
    public readonly issue: ClaimRecordIssue,
    options: ClaimRecordErrorOptions = {},
  ) {
    super(`Claim record unavailable for "${entry}": ${issue.kind}: ${issue.detail}`, {
      cause: options.cause,
    });
    this.name = 'ClaimRecordUnavailableError';
    this.rawName = entry;
    this.recordPath = options.recordPath;
    this.raw = options.raw;
  }
}

type LoadedClaimDescriptor = {
  descriptor: ClaimDescriptor;
  recordPath: string;
  raw: string;
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CURRENT_CLAIM_NAME = new RegExp(`^mclaim_1_(${UUID})\\.md$`, 'i');
const UNAVAILABLE_REASONS: readonly ProcessUnavailableReason[] = [
  'permission_denied',
  'unsupported',
  'query_failed',
  'timed_out',
  'identity_unverifiable',
  'incomplete_data',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function issue(kind: ClaimRecordIssue['kind'], detail: string): ClaimRecordIssue {
  return { kind, detail };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function validateEvidence(value: unknown): ClaimRecordIssue | undefined {
  if (!isRecord(value)) return issue('invalid', 'capture.evidence must be a JSON object');
  if (value.version !== 1) {
    return typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 1
      ? issue('unsupported', `capture.evidence version ${value.version} is not supported`)
      : issue('invalid', 'capture.evidence.version must be 1');
  }
  if (typeof value.atMs !== 'number' || !Number.isFinite(value.atMs)) {
    return issue('invalid', 'capture.evidence.atMs must be finite');
  }
  if (!Array.isArray(value.facts)) {
    return issue('invalid', 'capture.evidence.facts must be an array');
  }
  return undefined;
}

function validateCapture(value: unknown): ClaimRecordIssue | undefined {
  if (!isRecord(value)) return issue('invalid', 'capture must be a JSON object');
  if (typeof value.kind !== 'string') return issue('invalid', 'capture.kind must be a string');
  if (value.kind !== 'captured' && value.kind !== 'gone' && value.kind !== 'unknown') {
    return issue('unsupported', `capture kind "${value.kind}" is not supported`);
  }
  if (value.kind === 'captured' && !hasOwn(value, 'value')) {
    return issue('invalid', 'captured capture must contain value');
  }
  if (value.kind === 'unknown') {
    if (typeof value.reason !== 'string') {
      return issue('invalid', 'unknown capture must contain a public reason');
    }
    if (!UNAVAILABLE_REASONS.includes(value.reason as ProcessUnavailableReason)) {
      return issue('unsupported', `capture reason "${value.reason}" is not supported`);
    }
  }
  return validateEvidence(value.evidence);
}

export function isValidClaimOriginalName(value: unknown, channel: ClaimChannel): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && value.endsWith('.md')
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.includes(':')
    && (channel !== 'outbox' || !value.includes('..'));
}

function validateDescriptor(
  value: unknown,
  rawName: string,
  claimId: string,
  channel: ClaimChannel,
): ClaimRecordIssue | undefined {
  if (!isRecord(value)) return issue('invalid', 'claim record must be a JSON object');
  if (value.version !== 1) {
    return typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 1
      ? issue('unsupported', `claim record version ${value.version} is not supported`)
      : issue('invalid', 'claim record version must be 1');
  }
  if (value.claimId !== claimId) {
    return issue('invalid', 'claimId does not match the UUID in claimName');
  }
  if (value.channel !== channel) {
    return issue('invalid', `claim record channel must be "${channel}"`);
  }
  if (value.claimName !== rawName) {
    return issue('invalid', 'claimName does not match the source entry');
  }
  if (typeof value.createdAtMs !== 'number' || !Number.isFinite(value.createdAtMs)) {
    return issue('invalid', 'createdAtMs must be finite');
  }
  if (!isValidClaimOriginalName(value.originalName, channel)) {
    return issue('invalid', 'originalName is not a safe leaf .md filename for this channel');
  }
  return validateCapture(value.capture);
}

/** Load the immutable descriptor bound to one reserved source name; never fall back to legacy parsing. */
export async function loadClaimDescriptor(
  fs: FileSystem,
  sourceDir: string,
  rawName: string,
  channel: ClaimChannel,
): Promise<LoadedClaimDescriptor> {
  if (!rawName.startsWith('mclaim_')) {
    throw new ClaimRecordUnavailableError(
      rawName,
      issue('invalid', 'claim source name does not use the reserved mclaim_ prefix'),
    );
  }

  const match = CURRENT_CLAIM_NAME.exec(rawName);
  if (match === null) {
    const kind = rawName.startsWith('mclaim_1_') ? 'invalid' : 'unsupported';
    throw new ClaimRecordUnavailableError(
      rawName,
      issue(kind, 'reserved claim source name is not a supported mclaim_1_<uuid>.md name'),
    );
  }

  const claimId = match[1];
  const recordPath = `${sourceDir}-claims/${claimId}/record.json`;
  let raw: string;
  try {
    raw = await fs.read(recordPath);
  } catch (cause) {
    const missing = isFileNotFound(cause);
    const code = errorCode(cause);
    throw new ClaimRecordUnavailableError(rawName, {
      kind: missing ? 'missing' : 'io',
      detail: missing ? 'claim record is missing' : `claim record read failed: ${formatErr(cause)}`,
      ...(code !== undefined && { code }),
    }, { recordPath, cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ClaimRecordUnavailableError(
      rawName,
      issue('invalid', `claim record is not valid JSON: ${formatErr(cause)}`),
      { recordPath, raw, cause },
    );
  }

  const validationIssue = validateDescriptor(parsed, rawName, claimId, channel);
  if (validationIssue !== undefined) {
    throw new ClaimRecordUnavailableError(rawName, validationIssue, { recordPath, raw });
  }

  // Validation intentionally checks only Messaging fields and public L1 capture/evidence shells.
  // Returning the parsed object retains unknown fields; captured.value stays unknown for L1 decode.
  return { descriptor: parsed as ClaimDescriptor, recordPath, raw };
}
