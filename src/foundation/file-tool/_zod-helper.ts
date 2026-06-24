/**
 * @module L2c.FileTool.ZodHelper
 * file-tool 内部 helper：把 Zod schema 转 JSONSchema7 给 ToolDescriptor.schema。
 *
 * 使用 zodToJsonSchema 的 `target: 'jsonSchema7'` 选项确保兼容 ToolProtocol。
 *
 * phase 305 立、file-tool 6 tool 共用。
 * 完整 A 类 cluster phase 起后、此 helper 可迁 L2c tools/ 复用至全 20+ tool。
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JSONSchema7 } from '../tool-protocol/index.js';

export function defineFileToolSchema<T extends z.ZodTypeAny>(
  zodSchema: T,
): JSONSchema7 {
  return zodToJsonSchema(zodSchema, { target: 'jsonSchema7' }) as JSONSchema7;
}
