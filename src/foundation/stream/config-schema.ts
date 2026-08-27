/**
 * Stream config schema / phase 10 decentralize
 * Owner: stream（stream.jsonl retention yaml schema 业主）
 * Composed by: src/assembly/compose-config.ts (yaml `stream.retention.*` field)
 */
import { z } from 'zod';

export const streamConfigSchema = z.object({
  retention: z.object({
    max_files: z.number().min(1).nullable().default(null),
    max_days: z.number().min(1).nullable().default(null),
  }).default({}),
});
