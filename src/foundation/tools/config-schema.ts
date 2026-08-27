/**
 * Tools config schema / phase 10 decentralize
 * Owner: tools（工具调用 timeout yaml schema 业主）
 * Composed by: src/assembly/compose-config.ts (yaml `tool_timeout_ms` field)
 *
 * Default 60_000 ms = config-level tool timeout default (业务自报).
 * Independent of executor safety-net fallback in foundation/tools/constants.ts (1h).
 */
import { z } from 'zod';

export const TOOL_TIMEOUT_DEFAULT_MS = 60_000;

export const toolsConfigSchema = z
  .number()
  .min(1000)
  .max(600000)
  .default(TOOL_TIMEOUT_DEFAULT_MS);
