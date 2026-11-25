import { createCanonicalToolManifestFromDefinitions } from '../../../src/foundation/tools/index.js';
import { prepareSubagentInput } from '../../../src/core/subagent/index.js';
import type { PrepareRetroSubagentInput } from '../../../src/core/evolution-system/retro-scheduler.js';

/** Minimal valid lower-owner preparation for Evolution scheduling tests. */
export const prepareRetroInputForTest: PrepareRetroSubagentInput = declaration => prepareSubagentInput({
  ...declaration,
  tools: { manifest: createCanonicalToolManifestFromDefinitions([]) },
});
