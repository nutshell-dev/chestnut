/**
 * Per-task registry construction helper.
 *
 * Mirrors the pattern established in phase 780 / phase 944:
 * - skip the main shared DONE tool to avoid capturedResult state leak
 * - register a fresh done instance per task run
 */

import { createToolRegistry, type ToolRegistry } from '../../foundation/tools/index.js';
import { createDoneTool, DONE_TOOL_NAME } from './tools/done.js';

export function createPerTaskRegistry(
  srcRegistry: ToolRegistry,
  profile: string,
): ToolRegistry {
  const r = createToolRegistry();
  for (const tool of srcRegistry.getForProfile(profile as any)) {
    if (tool.name === DONE_TOOL_NAME) continue;
    r.register(tool);
  }
  r.register(createDoneTool());
  return r;
}
