import {
  configExists,
  readYamlDocument,
  withYamlConfigLock,
  writeYamlConfig,
} from '../../foundation/config-store/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { sha256Hex } from '../../foundation/node-utils/index.js';
import { createLocalCredentials } from './legacy-credentials/index.js';
import {
  ApiKeyConfigError,
  classifyApiKeyConfigValue,
  deriveCredentialRef,
} from './key-input.js';

export interface ApiKeyMigrationAudit {
  write(event: string, ...columns: string[]): void;
}

export interface ApiKeyMigrationOutcome {
  readonly role: string;
  readonly ref: string;
  readonly keyHash: string;
  readonly keyLength: number;
}

interface ApiKeySlot {
  readonly parent: Record<string, unknown>;
  readonly role: string;
  readonly value: unknown;
}

function collectSlots(value: unknown): ApiKeySlot[] {
  const slots: ApiKeySlot[] = [];
  const visit = (current: unknown, role: string): void => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${role}[${index}]`));
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    const record = current as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      const nextRole = role ? `${role}.${key}` : key;
      if (key === 'api_key') slots.push({ parent: record, role: nextRole, value: entry });
      else visit(entry, nextRole);
    }
  };
  visit(value, '');
  return slots;
}

function slotAtPath(root: unknown, role: string): ApiKeySlot | undefined {
  return collectSlots(root).find(slot => slot.role === role);
}

function migrationError(
  code: ConstructorParameters<typeof ApiKeyConfigError>[0],
  role: string,
  ref?: string,
): ApiKeyConfigError {
  return new ApiKeyConfigError(code, role, ref);
}

/**
 * Explicit async migration for any YAML document containing provider api_key fields.
 * The synchronous loader only classifies/rejects; this owner performs all writes.
 */
export async function migrateLegacyApiKeysAtPath(
  deps: { fsFactory(baseDir: string): FileSystem },
  configPath: string,
  audit?: ApiKeyMigrationAudit,
): Promise<readonly ApiKeyMigrationOutcome[]> {
  if (!configExists(deps, configPath)) return [];
  const credentials = createLocalCredentials(deps);
  const document = readYamlDocument(deps, configPath);
  const outcomes: ApiKeyMigrationOutcome[] = [];
  for (const slot of collectSlots(document)) {
    const classified = classifyApiKeyConfigValue(slot.value);
    if (classified.kind === 'missing' || classified.kind === 'reference') continue;
    if (classified.kind === 'invalid-reference') {
      throw migrationError('invalid_reference', slot.role, classified.ref);
    }
    const keyHash = sha256Hex(classified.value);
    const ref = deriveCredentialRef(`${slot.role}_${keyHash.slice(0, 12)}`);
    const reference = '${' + ref + '}';
    const outcome = {
      role: slot.role,
      ref,
      keyHash,
      keyLength: classified.value.length,
    } as const;
    const emit = (result: 'migrated' | 'orphan_ref' | 'failed'): void => {
      audit?.write(
        'llm_api_key_migration',
        `source=${classified.source}`,
        `role=${slot.role}`,
        `ref=${ref}`,
        `key_hash=${keyHash}`,
        `key_length=${classified.value.length}`,
        `outcome=${result}`,
      );
    };
    try {
      const existing = credentials.resolve(ref);
      if (existing !== undefined && existing.value !== classified.value) {
        throw migrationError('credential_unavailable', slot.role, ref);
      }
      if (existing === undefined) await credentials.set(ref, classified.value);
      const confirmed = credentials.resolve(ref);
      if (confirmed?.value !== classified.value) {
        throw migrationError('credential_unavailable', slot.role, ref);
      }

      let writeError: unknown;
      try {
        let result: ReturnType<typeof writeYamlConfig> | undefined;
        await withYamlConfigLock(deps, configPath, () => {
          const fresh = readYamlDocument(deps, configPath);
          const freshSlot = slotAtPath(fresh, slot.role);
          if (!freshSlot) throw migrationError('migration_conflict', slot.role, ref);
          if (freshSlot.value === reference) return;
          if (freshSlot.value !== slot.value) {
            throw migrationError('migration_conflict', slot.role, ref);
          }
          freshSlot.parent.api_key = reference;
          result = writeYamlConfig(deps, configPath, fresh);
        });
        if (result?.kind === 'committed_durability_unknown') {
          throw migrationError('migration_not_confirmed', slot.role, ref);
        }
      } catch (error) {
        // silent: the write outcome is reloaded and classified below
        writeError = error;
      }

      const reloadedSlot = slotAtPath(readYamlDocument(deps, configPath), slot.role);
      if (reloadedSlot?.value !== reference || credentials.resolve(ref)?.value !== classified.value) {
        emit('orphan_ref');
        throw migrationError(
          writeError instanceof ApiKeyConfigError ? writeError.code : 'migration_not_confirmed',
          slot.role,
          ref,
        );
      }
      if (writeError instanceof ApiKeyConfigError
        && writeError.code === 'migration_not_confirmed') {
        emit('failed');
        throw writeError;
      }
      emit('migrated');
      outcomes.push(outcome);
    } catch (error) {
      if (error instanceof ApiKeyConfigError) throw error;
      // Underlying credential/I/O errors may contain the plaintext; expose only a safe code.
      throw migrationError('credential_unavailable', slot.role, ref);
    }
  }
  return outcomes;
}
