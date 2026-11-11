/**
 * @module L4.LLMConfiguration.Propagation
 *
 * 配置保存之后的通知/应用事实。配置文档 revision 是 saved 权威；inbox 仅是
 * 加速提示，应用记录允许 daemon 在通知丢失、失败或已 ack 后于重启时恢复。
 */
import * as path from 'path';
import { z } from 'zod';
import {
  configExists,
  readYamlDocument,
  withYamlConfigLockAsync,
  writeYamlConfig,
} from '../../foundation/config-store/index.js';
import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import type { AtomicWriteResult, FileSystem } from '../../foundation/fs/index.js';
import { formatErr, sha256Hex } from '../../foundation/node-utils/index.js';

const applicationSchema = z.object({
  schema_version: z.literal(1),
  claw_id: z.string().min(1),
  process_id: z.number().int().positive(),
  revision: z.string().min(1),
  identity: z.string().min(1),
  outcome: z.enum(['applied', 'failed']),
  publish_pending: z.boolean(),
  last_applied_revision: z.string().optional(),
  last_applied_identity: z.string().optional(),
  updated_at: z.string(),
  error: z.string().optional(),
});
export type LLMApplicationFact = z.infer<typeof applicationSchema>;

export interface RecordLLMApplicationInput {
  clawId: string;
  processId: number;
  revision: string;
  identity: string;
  outcome: 'applied' | 'failed';
  publishPending: boolean;
  error?: unknown;
}

export interface LLMApplicationStore {
  read(clawId: string): LLMApplicationFact | undefined;
  record(input: RecordLLMApplicationInput): Promise<AtomicWriteResult>;
}

function applicationPath(clawId: string): string {
  return path.join(getChestnutRoot(), 'llm', 'applications', `${sha256Hex(clawId)}.yaml`);
}

export function createLLMApplicationStore(deps: {
  fsFactory(baseDir: string): FileSystem;
}): LLMApplicationStore {
  return {
    read: (clawId) => {
      const filePath = applicationPath(clawId);
      if (!configExists(deps, filePath)) return undefined;
      return applicationSchema.parse(readYamlDocument(deps, filePath));
    },
    record: async (input) => {
      const filePath = applicationPath(input.clawId);
      return withYamlConfigLockAsync(deps, filePath, async () => {
        const previous = configExists(deps, filePath)
          ? applicationSchema.parse(readYamlDocument(deps, filePath))
          : undefined;
        const lastApplied = input.outcome === 'applied'
          ? { last_applied_revision: input.revision, last_applied_identity: input.identity }
          : previous?.outcome === 'applied'
            ? {
              last_applied_revision: previous.last_applied_revision ?? previous.revision,
              last_applied_identity: previous.last_applied_identity ?? previous.identity,
            }
            : {
              ...(previous?.last_applied_revision !== undefined
                ? { last_applied_revision: previous.last_applied_revision }
                : {}),
              ...(previous?.last_applied_identity !== undefined
                ? { last_applied_identity: previous.last_applied_identity }
                : {}),
            };
        return writeYamlConfig(deps, filePath, {
          schema_version: 1,
          claw_id: input.clawId,
          process_id: input.processId,
          revision: input.revision,
          identity: input.identity,
          outcome: input.outcome,
          publish_pending: input.outcome === 'failed'
            ? (previous?.publish_pending ?? input.publishPending)
            : input.publishPending,
          ...lastApplied,
          updated_at: new Date().toISOString(),
          ...(input.error !== undefined ? { error: formatErr(input.error).slice(0, 500) } : {}),
        } satisfies LLMApplicationFact);
      });
    },
  };
}

const notificationSchema = z.object({
  schema_version: z.literal(1),
  revision: z.string().min(1),
  target: z.string().min(1),
  status: z.enum(['pending', 'sent', 'failed', 'offline']),
  updated_at: z.string(),
  error: z.string().optional(),
});
export type LLMNotificationFact = z.infer<typeof notificationSchema>;

export interface LLMNotificationStore {
  read(revision: string, target: string): LLMNotificationFact | undefined;
  record(input: {
    revision: string;
    target: string;
    status: LLMNotificationFact['status'];
    error?: unknown;
  }): AtomicWriteResult;
}

function notificationPath(revision: string, target: string): string {
  const id = sha256Hex(`${revision}\0${target}`);
  return path.join(getChestnutRoot(), 'llm', 'notifications', `${id}.yaml`);
}

export function createLLMNotificationStore(deps: {
  fsFactory(baseDir: string): FileSystem;
}): LLMNotificationStore {
  return {
    read: (revision, target) => {
      const filePath = notificationPath(revision, target);
      if (!configExists(deps, filePath)) return undefined;
      return notificationSchema.parse(readYamlDocument(deps, filePath));
    },
    record: (input) => writeYamlConfig(deps, notificationPath(input.revision, input.target), {
      schema_version: 1,
      revision: input.revision,
      target: input.target,
      status: input.status,
      updated_at: new Date().toISOString(),
      ...(input.error !== undefined ? { error: formatErr(input.error).slice(0, 500) } : {}),
    } satisfies LLMNotificationFact),
  };
}
