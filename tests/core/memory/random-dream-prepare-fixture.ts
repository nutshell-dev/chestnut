import { createCanonicalToolManifestFromDefinitions } from '../../../src/foundation/tools/index.js';
import { prepareSubagentInput } from '../../../src/core/subagent/index.js';
import type { PrepareRandomDreamInput } from '../../../src/core/memory/random-dream.js';

const manifest = createCanonicalToolManifestFromDefinitions([]);

/** Real SubAgent preparation with the fixed tool binding supplied by the fixture. */
export const prepareRandomDreamInputFixture: PrepareRandomDreamInput = declaration =>
  prepareSubagentInput({ ...declaration, tools: { manifest } });
