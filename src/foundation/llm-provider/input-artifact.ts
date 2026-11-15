import type { InputArtifactRef, InputArtifactStatus } from './input-measurement-observer.js';

/** Explicit per-call policy supplied by the assembly/caller; no storage is implied by default. */
export interface InputArtifactPolicy {
  readonly redactionPolicy?: string;
}

export interface InputArtifactCapture {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  /** Canonical projected input in memory; owners must never persist undeclared extensions. */
  readonly input: unknown;
  readonly policy?: InputArtifactPolicy;
}

export interface InputArtifactManifest {
  readonly status: InputArtifactStatus;
  readonly contentHash?: string;
  readonly byteLength?: number;
  readonly redactionPolicy?: string;
  readonly reason?: string;
}

/** Assembly-owned persistence seam. L1 neither chooses a directory nor writes prompt bytes. */
export interface InputArtifactOwner {
  capture(input: InputArtifactCapture): Promise<InputArtifactManifest> | InputArtifactManifest;
}

export function unavailableInputArtifact(requestId: string, reason: string): InputArtifactRef {
  return {
    artifactId: artifactIdForRequest(requestId),
    schemaVersion: 1,
    status: 'unavailable',
    hashAlgorithm: 'sha256',
    reason,
  };
}

export async function captureInputArtifact(
  owner: InputArtifactOwner | undefined,
  input: InputArtifactCapture,
): Promise<InputArtifactRef> {
  if (!owner) return unavailableInputArtifact(input.requestId, 'artifact_owner_unconfigured');
  try {
    const manifest = await owner.capture(input);
    if (!validManifest(manifest)) return unavailableInputArtifact(input.requestId, 'artifact_manifest_invalid');
    const redactionPolicy = manifest.redactionPolicy ?? input.policy?.redactionPolicy;
    return {
      artifactId: artifactIdForRequest(input.requestId),
      schemaVersion: 1,
      status: manifest.status,
      hashAlgorithm: 'sha256',
      ...(manifest.contentHash !== undefined ? { contentHash: manifest.contentHash } : {}),
      ...(manifest.byteLength !== undefined ? { byteLength: manifest.byteLength } : {}),
      ...(redactionPolicy !== undefined ? { redactionPolicy } : {}),
      ...(manifest.reason !== undefined ? { reason: manifest.reason } : {}),
    };
  } catch {
    // silent: converted to a stable unavailable manifest without leaking capture errors.
    // Do not leak capture errors (which may contain input) or block the provider request.
    return unavailableInputArtifact(input.requestId, 'artifact_capture_failed');
  }
}

function artifactIdForRequest(requestId: string): string {
  return `input-artifact-${requestId}`;
}

function validManifest(manifest: InputArtifactManifest): boolean {
  return (manifest.status === 'available' || manifest.status === 'redacted' || manifest.status === 'unavailable')
    && (manifest.contentHash === undefined || /^[0-9a-f]{64}$/.test(manifest.contentHash))
    && (manifest.byteLength === undefined || (Number.isSafeInteger(manifest.byteLength) && manifest.byteLength >= 0));
}
